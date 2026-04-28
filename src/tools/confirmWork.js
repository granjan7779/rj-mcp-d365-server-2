// src/tools/confirmWork.js
// Tool: confirmWork — posts warehouse work confirmation to D365
// FULLY PARAMETERIZED: every _data field comes from Foundry
// messageId REQUIRED — format: msg- + up to 16 alphanumeric chars (max 20 total)

const axios = require('axios');
const { getD365Token } = require('../auth/d365Auth');
require('dotenv').config();

// ── messageId Validator ───────────────────────────────────────────
// Rules: must start with 'msg-', followed by 1-16 alphanumeric chars
// Total max length: 20 characters
function validateMessageId(messageId) {
  if (!messageId) {
    throw new Error('messageId is required. Format: msg-XXXXXXX (e.g. msg-ABC1234567)');
  }
  if (!messageId.startsWith('msg-')) {
    throw new Error(
      `Invalid messageId '${messageId}' — must start with 'msg-'. Example: msg-ABC1234567`
    );
  }
  if (messageId.length > 20) {
    throw new Error(
      `messageId too long (${messageId.length} chars). Maximum is 20 characters including 'msg-'.`
    );
  }
  const pattern = /^msg-[a-zA-Z0-9]{1,16}$/;
  if (!pattern.test(messageId)) {
    throw new Error(
      `Invalid messageId '${messageId}'. Must be msg- followed by 1-16 alphanumeric characters. `
      + 'No spaces, dashes or special characters after the prefix.'
    );
  }
}

// ── Schema ───────────────────────────────────────────────────────
const schema = {
  name: 'confirmWork',
  description:
    'Confirms completion of a warehouse pick task in Dynamics 365. '
    + 'Use when a user wants to confirm a pick order or close a work order. '
    + 'messageId is required and must start with msg- (e.g. msg-ABC1234567).',
  parameters: {
    type: 'object',
    properties: {
      workLinePairId:     { type: 'string', description: 'Work line pair ID. → _data01. Example: MHWKL-000000002' },
      workLineRecId:      { type: 'string', description: 'Work line RecId value. → _data02. Example: 68719480119' },
      fromLicensePlate:   { type: 'string', description: 'License plate to pick FROM. → _data03. Example: LP24NEW' },
      targetLicensePlate: { type: 'string', description: 'Target license plate. → _data04. Example: LP24NEW' },
      workLineNumber:     { type: 'string', description: 'Work line number. → _data05. Example: 1' },
      quantity:           { type: 'string', description: 'Quantity picked. → _data06. Example: 24' },
      workLinePairIdRef:  { type: 'string', description: 'Work line pair ID reference. → _data07. Usually same as workLinePairId.' },
      workType:           { type: 'string', description: 'Work type. → _data08.', enum: ['Pick','Put','Count','Adjust'], default: 'Pick' },
      fromLocation:       { type: 'string', description: 'From location code. → _data09. Example: FL-001' },
      inboundTransType:   { type: 'string', description: 'D365 transaction type. → _inboundTransType.', enum: ['WorkConfirm','Receiving','Shipment'], default: 'WorkConfirm' },
      messageId:          { type: 'string', description: 'REQUIRED. Unique message ID. → _messageId. Format: msg- + up to 16 alphanumeric chars. Max 20 chars. Example: msg-ABC1234567', maxLength: 20, pattern: '^msg-[a-zA-Z0-9]{1,16}$' }
    },
    required: ['workLinePairId','workLineRecId','fromLicensePlate','targetLicensePlate',
               'workLineNumber','quantity','workType','fromLocation','inboundTransType','messageId']
  }
};

// ── Executor ─────────────────────────────────────────────────────
async function execute(params) {

  // Validate all required fields
  const required = ['workLinePairId','workLineRecId','fromLicensePlate','targetLicensePlate',
                    'workLineNumber','quantity','workType','fromLocation','inboundTransType','messageId'];
  const missing = required.filter(f => !params[f]);
  if (missing.length > 0) throw new Error(`Missing required parameters: ${missing.join(', ')}`);

  // Validate messageId format
  validateMessageId(params.messageId);

  const token = await getD365Token();

  const url = `${process.env.D365_BASE_URL}`
    + `/api/services/WMHEServices/WMHEService/executeInboundTransaction`;

  // Map Foundry params → D365 _data fields (nothing hardcoded)
  const d365Payload = {
    _data01:           params.workLinePairId,                          // Work line pair ID
    _data02:           params.workLineRecId,                           // Work line RecId
    _data03:           params.fromLicensePlate,                        // License plate FROM
    _data04:           params.targetLicensePlate,                      // Target license plate
    _data05:           params.workLineNumber,                          // Work line number
    _data06:           params.quantity,                                // Quantity
    _data07:           params.workLinePairIdRef ?? params.workLinePairId, // Pair ID ref
    _data08:           params.workType ?? 'Pick',                      // Work type
    _data09:           params.fromLocation,                            // From location
    _data10:           '',                                             // Not used — always empty
    _inboundTransType: params.inboundTransType ?? 'WorkConfirm',       // Trans type
    _messageId:        params.messageId                                // Message ID
  };

  console.log('[confirmWork] D365 payload:', JSON.stringify(d365Payload, null, 2));

  const response = await axios.post(url, d365Payload, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 30000
  });

  return {
    success:      true,
    tool:         'confirmWork',
    messageId:    params.messageId,
    confirmedFor: { workLinePairId: params.workLinePairId, workLineRecId: params.workLineRecId, quantity: params.quantity },
    d365Response: response.data,
    message: `Work confirmed — pair: ${params.workLinePairId}, recId: ${params.workLineRecId}, qty: ${params.quantity}, msg: ${params.messageId}`
  };
}

module.exports = { schema, execute };
