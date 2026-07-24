// Vision Option Pro — Angel One SmartAPI Live Data Server
//
// Credentials from Render Environment tab:
//   ANGEL_CLIENT_CODE, ANGEL_MPIN, ANGEL_API_KEY, ANGEL_TOTP_SECRET
//
// Flow:
//   1) Generate TOTP from ANGEL_TOTP_SECRET
//   2) POST /rest/auth/angelbroking/user/v1/loginByPassword -> jwtToken, feedToken
//   3) Fetch public Instrument Master JSON (no auth) to find NIFTY option tokens
//   4) POST /rest/secure/angelbroking/market/v1/quote/ -> LTP, OI, Volume for those tokens

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { authenticator } = require('otplib');

const app = express();
const PORT = process.env.PORT || 5000;
app.use(cors());

const API_BASE = 'https://apiconnect.angelbroking.com';
const INSTRUMENT_MASTER_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

let session = null; // { jwtToken, feedToken, expiresAt }
let instrumentCache = null; // { data, fetchedAt }

function commonHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00',
    'X-PrivateKey': apiKey,
  };
}

async function login() {
  const clientcode = (process.env.ANGEL_CLIENT_CODE || '').trim();
  const mpin = (process.env.ANGEL_MPIN || '').trim();
  const apiKey = (process.env.ANGEL_API_KEY || '').trim();
  const totpSecret = (process.env.ANGEL_TOTP_SECRET || '').replace(/\s+/g, '').toUpperCase();

  if (!clientcode || !mpin || !apiKey || !totpSecret) {
    throw new Error('Missing one or more ANGEL_* environment variables');
  }

  const totp = authenticator.generate(totpSecret);
  console.log('DEBUG clientcode:', clientcode, 'totpSecret length:', totpSecret.length, 'generated TOTP:', totp);

  const loginRes = await axios.post(
    `${API_BASE}/rest/auth/angelbroking/user/v1/loginByPassword`,
    { clientcode, password: mpin, totp },
    { headers: commonHeaders(apiKey), timeout: 10000 }
  );
  console.log('DEBUG login response status:', loginRes.data.status, 'message:', loginRes.data.message);

  if (!loginRes.data.status) {
    throw new Error('Login failed: ' + JSON.stringify(loginRes.data));
  }

  const jwtToken = loginRes.data.data.jwtToken;
  const feedToken = loginRes.data.data.feedToken;

  session = {
    jwtToken,
    feedToken,
    apiKey,
    clientcode,
    expiresAt: Date.now() + 6 * 60 * 60 * 1000,
  };
  return session;
}

async function ensureSession() {
  if (!session || Date.now() > session.expiresAt) {
    await login();
  }
  return session;
}

function authHeaders(s) {
  return {
    ...commonHeaders(s.apiKey),
    Authorization: `Bearer ${s.jwtToken}`,
    'X-ClientCode': s.clientcode,
    'X-FeedToken': s.feedToken,
  };
}

async function getInstrumentMaster() {
  if (instrumentCache && Date.now() - instrumentCache.fetchedAt < 60 * 60 * 1000) {
    return instrumentCache.data;
  }
  const res = await axios.get(INSTRUMENT_MASTER_URL, { timeout: 30000 });
  instrumentCache = { data: res.data, fetchedAt: Date.now() };
  console.log('DEBUG instrument master total entries:', res.data.length);
  return res.data;
}

// TEST ENDPOINT: verifies login + shows sample NIFTY instrument entries
app.get('/api/test', async (req, res) => {
  try {
    const s = await ensureSession();
    const instruments = await getInstrumentMaster();

    // Find NIFTY option contracts (NFO segment)
    const niftyOptions = instruments.filter(
      (i) => i.name === 'NIFTY' && i.exch_seg === 'NFO' && i.instrumenttype === 'OPTIDX'
    );
    console.log('DEBUG NIFTY option contracts found:', niftyOptions.length);
    console.log('DEBUG sample NIFTY option entry:', JSON.stringify(niftyOptions[0]));

    // Find NIFTY spot index entry
    const niftySpot = instruments.find(
      (i) => (i.symbol === 'NIFTY 50' || i.name === 'NIFTY 50') && i.exch_seg === 'NSE'
    );
    console.log('DEBUG NIFTY spot entry:', JSON.stringify(niftySpot));

    res.json({
      status: 'login successful',
      totalInstruments: instruments.length,
      niftyOptionCount: niftyOptions.length,
      sampleNiftyOption: niftyOptions[0] || null,
      sampleNiftySpot: niftySpot || null,
      first5NiftyOptions: niftyOptions.slice(0, 5),
    });
  } catch (err) {
    console.error('Angel One API test failed:', err.response ? JSON.stringify(err.response.data) : err.message);
    res.status(502).json({
      error: 'Angel One API call failed',
      detail: err.response ? err.response.data : err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Vision Option Pro (Angel One) server running on port ${PORT}`);
});
