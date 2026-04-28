// src/tools/readLines.js
// Tool: readOpenLines — reads open outbound pick orders from D365
// ALL parameters come from Azure AI Foundry — nothing hardcoded

const axios = require('axios');
const { getD365Token } = require('../auth/d365Auth');
require('dotenv').config();

const schema = {
  name: 'readOpenLines',
  description:
    'Reads open outbound pick lines from the D365 warehouse MHAX subscription queue. '
    + 'Use when a user asks about pending pick orders, open warehouse tasks, '
    + 'outbound shipments awaiting picking, or wants to see the current pick queue.',
  parameters: {
    type: 'object',
    properties: {
      subscriptionId: {
        type: 'string',
        description: "Queue ID to read from. Use 'so_out_pick' for sales order picks.",
        default: 'so_out_pick'
      },
      numberOfRecords: {
        type: 'integer',
        description: 'How many records to retrieve. Between 1 and 100. Default: 1.',
        minimum: 1, maximum: 100, default: 1
      }
    },
    required: []
  }
};

async function execute(params = {}) {
  const subscriptionId  = params.subscriptionId  ?? 'so_out_pick';
  const numberOfRecords = params.numberOfRecords  ?? 1;

  const token = await getD365Token();

  const url = `${process.env.D365_BASE_URL}`
    + `/api/services/WMHEServices/WMHEService/readOutboundSubscriptionQueue`;

  const d365Payload = {
    _subscriptionId:  subscriptionId,   // From Foundry
    _numberOfRecords: numberOfRecords   // From Foundry
  };

  console.log('[readOpenLines] Calling D365 with:', d365Payload);

  const response = await axios.post(url, d365Payload, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 30000
  });

  return {
    success:     true,
    tool:        'readOpenLines',
    queryParams: { subscriptionId, numberOfRecords },
    recordCount: Array.isArray(response.data) ? response.data.length : 1,
    data:        response.data,
    message:     `Retrieved pick lines from queue '${subscriptionId}'`
  };
}

module.exports = { schema, execute };
