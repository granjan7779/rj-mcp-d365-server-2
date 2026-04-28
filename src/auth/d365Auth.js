// src/auth/d365Auth.js
// OAuth 2.0 v2 token management for D365
// Uses /oauth2/v2.0/token with scope (NOT legacy /oauth2/token with resource)

const axios  = require('axios');
require('dotenv').config();

let cachedToken = null;
let tokenExpiry = null;

async function getD365Token() {
  const now = Date.now();

  // Reuse cached token if still valid (avoids login on every API call)
  if (cachedToken && tokenExpiry && now < tokenExpiry) {
    console.log('♻️  Reusing cached D365 token');
    return cachedToken;
  }

  // IMPORTANT: Use v2.0 endpoint — legacy /oauth2/token is rejected by new App Registrations
  const tokenUrl =
    `https://login.microsoftonline.com/${process.env.D365_TENANT_ID}/oauth2/v2.0/token`;

  // IMPORTANT: Use 'scope' with /.default — NOT 'resource' without /.default
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     process.env.D365_CLIENT_ID,
    client_secret: process.env.D365_CLIENT_SECRET,
    scope:         `${process.env.D365_BASE_URL}/.default`
  });

  console.log('🔐 Requesting D365 token...');
  console.log('🔐 Token URL:', tokenUrl);
  console.log('🔐 Scope:', `${process.env.D365_BASE_URL}/.default`);

  try {
    const { data } = await axios.post(tokenUrl, body);
    cachedToken = data.access_token;
    // Cache for token lifetime minus 5 minutes safety buffer
    tokenExpiry = now + (data.expires_in - 300) * 1000;
    console.log('✅ D365 OAuth token refreshed');
    console.log('⏱️  Expires in:', data.expires_in, 'seconds');
    return cachedToken;
  } catch (err) {
    console.error('❌ FULL D365 ERROR:', JSON.stringify(err.response?.data, null, 2));
    console.error('❌ STATUS:', err.response?.status);
    console.error('❌ MESSAGE:', err.message);
    throw new Error('D365 authentication failed — check credentials in .env');
  }
}

module.exports = { getD365Token };
