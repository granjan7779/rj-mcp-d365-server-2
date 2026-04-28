// src/server.js
// MCP Server using Streamable HTTP transport (stateful mode).
// Azure AI Foundry's MCP connector requires stateful sessions (Mcp-Session-Id).
//
// Endpoints:
//   POST /mcp       Foundry JSON-RPC   (initialize, tools/list, tools/call)
//   GET  /mcp       Open SSE stream for session (optional server->client)
//   DELETE /mcp     Terminate session
//   GET  /health    Azure App Service health probe
//   /tools/*        Legacy REST for Postman testing only

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const morgan  = require('morgan');
const crypto  = require('crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z }         = require('zod');
const { getAllTools, getTool, executeTool } = require('./tools/registry');
const { getD365Token } = require('./auth/d365Auth');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS ────────────────────────────────────────────────────────────
// Foundry posts from a different origin and sends Mcp-Session-Id and
// mcp-protocol-version headers.
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Accept',
    'Authorization',
    'Mcp-Session-Id',
    'mcp-protocol-version',
    'mcp-session-id'
  ],
  exposedHeaders: ['Mcp-Session-Id', 'mcp-session-id']
}));

app.use(express.json({ limit: '4mb' }));
app.use(morgan('combined'));

// Diagnostic — every /mcp request logs headers so we can see what Foundry sends
app.use('/mcp', (req, _res, next) => {
  console.log('[MCP]', req.method, req.originalUrl,
    'headers:', JSON.stringify({
      'content-type':         req.headers['content-type'],
      'accept':               req.headers['accept'],
      'mcp-session-id':       req.headers['mcp-session-id'],
      'mcp-protocol-version': req.headers['mcp-protocol-version'],
      'user-agent':           req.headers['user-agent']
    }));
  next();
});

// ── Register MCP tools ──────────────────────────────────────────────
function registerTools(mcpServer) {
  mcpServer.tool(
    'readOpenLines',
    'Reads open outbound pick lines from D365 warehouse MHAX subscription queue. '
    + 'Use when user asks about pending pick orders or open warehouse tasks.',
    {
      subscriptionId:  z.string().default('so_out_pick')
        .describe("Queue ID. Default: 'so_out_pick'"),
      numberOfRecords: z.number().int().min(1).max(100).default(1)
        .describe('Records to retrieve. 1-100. Default: 1.')
    },
    async (params) => {
      console.log('[MCP] readOpenLines called:', params);
      try {
        const result = await executeTool('readOpenLines', params);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        console.error('[MCP] readOpenLines error:', err.message);
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  mcpServer.tool(
    'confirmWork',
    'Confirms completion of a warehouse pick task in D365. '
    + 'Use when user wants to confirm or close a work order. '
    + 'messageId required — format: msg- followed by up to 16 alphanumeric chars.',
    {
      workLinePairId:     z.string().describe('Work line pair ID. → _data01. Example: MHWKL-000000002'),
      workLineRecId:      z.string().describe('Work line RecId. → _data02. Example: 68719480119'),
      fromLicensePlate:   z.string().describe('License plate to pick FROM. → _data03. Example: LP24NEW'),
      targetLicensePlate: z.string().describe('Target license plate. → _data04. Example: LP24NEW'),
      workLineNumber:     z.string().describe('Work line number. → _data05. Example: 1'),
      quantity:           z.string().describe('Quantity picked. → _data06. Example: 24'),
      workLinePairIdRef:  z.string().optional().describe('Work line pair ID ref. → _data07. Usually same as workLinePairId.'),
      workType:           z.enum(['Pick','Put','Count','Adjust']).default('Pick').describe('Work type. → _data08.'),
      fromLocation:       z.string().describe('From location code. → _data09. Example: FL-001'),
      inboundTransType:   z.enum(['WorkConfirm','Receiving','Shipment']).default('WorkConfirm').describe('Transaction type. → _inboundTransType.'),
      messageId:          z.string().regex(/^msg-[a-zA-Z0-9]{1,16}$/)
        .describe('REQUIRED. Unique message ID. Format: msg- + up to 16 alphanumeric chars. Example: msg-ABC1234567')
    },
    async (params) => {
      console.log('[MCP] confirmWork called:', params);
      try {
        const result = await executeTool('confirmWork', params);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        console.error('[MCP] confirmWork error:', err.message);
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}

// ── Health / root ───────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:    'healthy',
    server:    'RJ D365 MHAX MCP Server',
    version:   '3.1.0',
    transport: 'streamable-http (stateful)',
    sessions:  Object.keys(sessions).length,
    timestamp: new Date().toISOString()
  });
});
app.get('/', (_req, res) => {
  res.json({
    name:      'RJ D365 MHAX MCP Server',
    version:   '3.1.0',
    transport: 'streamable-http (stateful)',
    endpoints: { mcp: 'POST/GET/DELETE /mcp', tools: '/tools', health: '/health' }
  });
});

// Startup: warm-up D365 token
(async () => {
  try {
    await getD365Token();
    console.log('✅ Startup: D365 OAuth credentials verified.');
  } catch (err) {
    console.error('⚠️  Startup: D365 token fetch FAILED —', err.message);
  }
})();

// ── /mcp — stateful Streamable HTTP ─────────────────────────────────
// One transport + McpServer per MCP session. Session ID is issued on
// initialize and must be sent by the client on every subsequent request.
const sessions = {};   // sessionId -> { transport, mcpServer }

async function createSession() {
  const mcpServer = new McpServer({
    name:    'RJ D365 MHAX MCP Server',
    version: '3.1.0'
  });
  registerTools(mcpServer);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (sid) => {
      sessions[sid] = { transport, mcpServer };
      console.log('✅ MCP session created:', sid);
    }
  });

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid && sessions[sid]) {
      delete sessions[sid];
      console.log('🔌 MCP session closed:', sid);
    }
  };

  await mcpServer.connect(transport);
  return transport;
}

function isInitializeRequest(body) {
  if (Array.isArray(body)) return body.some(isInitializeRequest);
  return body && body.method === 'initialize';
}

async function handleMcp(req, res) {
  try {
    const sid = req.headers['mcp-session-id'];
    let transport;

    if (sid && sessions[sid]) {
      transport = sessions[sid].transport;
    } else if (!sid && req.method === 'POST' && isInitializeRequest(req.body)) {
      transport = await createSession();
    } else {
      // GET/DELETE without session, or POST without session+not initialize
      return res.status(400).json({
        jsonrpc: '2.0',
        error:   { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id:      null
      });
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('❌ /mcp error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error:   { code: -32603, message: 'Internal server error: ' + err.message },
        id:      null
      });
    }
  }
}

// Accept /mcp AND /mcp/ (trailing slash)
app.post(['/mcp', '/mcp/'],   handleMcp);
app.get (['/mcp', '/mcp/'],   handleMcp);
app.delete(['/mcp', '/mcp/'], handleMcp);

// ── REST /tools (Postman testing only) ──────────────────────────────
app.get('/tools', (_req, res) => {
  res.json({ count: getAllTools().length, tools: getAllTools() });
});
app.get('/tools/:toolName', (req, res) => {
  const tool = getTool(req.params.toolName);
  if (!tool) return res.status(404).json({ error: `Tool '${req.params.toolName}' not found` });
  res.json(tool.schema);
});
app.post('/tools/:toolName', async (req, res) => {
  try {
    const result = await executeTool(req.params.toolName, req.body);
    res.json({ success: true, tool: req.params.toolName, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 MCP Server v3.1.0 listening on port ${PORT}`);
  console.log(`🔌 MCP (Foundry): POST http://localhost:${PORT}/mcp (stateful)`);
  console.log(`📋 REST tools:    http://localhost:${PORT}/tools`);
  console.log(`🏥 Health:        http://localhost:${PORT}/health`);
});
