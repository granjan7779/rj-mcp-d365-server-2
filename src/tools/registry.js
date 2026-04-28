// src/tools/registry.js
// Central catalog — add new tools here

const readLines   = require('./readLines');
const confirmWork = require('./confirmWork');

const TOOL_MAP = {
  readOpenLines: readLines,
  confirmWork:   confirmWork
};

function getAllTools()   { return Object.values(TOOL_MAP).map(t => t.schema); }
function getTool(name)  { return TOOL_MAP[name] || null; }

async function executeTool(name, params) {
  const tool = TOOL_MAP[name];
  if (!tool) throw new Error(`Tool '${name}' not found. Available: ${Object.keys(TOOL_MAP).join(', ')}`);
  return await tool.execute(params);
}

module.exports = { getAllTools, getTool, executeTool };
