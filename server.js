// Vision Option Pro — Kotak Neo Trade API Live Data Server
//
// Uses official Kotak Neo Trade API (not NSE scraping) for reliable live data.
// Credentials come from environment variables set in Render's Environment tab:
//   KOTAK_ACCESS_TOKEN, KOTAK_MOBILE, KOTAK_UCC, KOTAK_TOTP_SECRET, KOTAK_MPIN
//
// Flow:
//   1) Generate a fresh 6-digit TOTP from KOTAK_TOTP_SECRET
//   2) POST /login/1.0/tradeApiLogin (mobileNumber, ucc, totp) -> viewToken, viewSid
//   3) POST /login/1.0/tradeApiValidate (mpin) -> sessionToken, sessionSid, baseUrl
//   4) Use baseUrl + sessionToken/sessionSid for all further calls (quotes, scripmaster)

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { authenticator } = require('otplib');

const app = express();
const PORT = process.env.PORT || 5000;
app.use(cors());

const LOGIN_BASE = 'https://mis.kotaksecurities.com';

let session = null; // { token, sid, baseUrl, expiresAt }

async function login() {
  const accessToken = process.env.KOTAK_ACCESS_TOKEN;
  const mobile = process.env.KOTAK_MOBILE;
  const ucc = process.env.KOTAK_UCC;
  const totpSecret = (process.env.KOTAK_TOTP_SECRET || '').replace(/\s+/g, '').toUpperCase();
  const mpin = process.env.KOTAK_MPIN;

  if (!accessToken || !mobile || !ucc || !totpSecret || !mpin) {
    throw new Error('Missing one or more KOTAK_* environment variables');
  }

  const totp = authenticator.generate(totpSecret);
  console.log('DEBUG totpSecret length:', totpSecret.length);
  console.log('DEBUG generated TOTP:', totp);

  // Step 1: tradeApiLogin
  const loginRes = await axios.post(
    `${LOGIN_BASE}/login/1.0/tradeApiLogin`,
    { mobileNumber: mobile, ucc, totp },
    {
      headers: {
        Authorization: accessToken,
        'neo-fin-key': 'neotradeapi',
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }
  );
  console.log('DEBUG tradeApiLogin status:', loginRes.status);
  const viewToken = loginRes.data.data.token;
  const viewSid = loginRes.data.data.sid;

  // Step 2: tradeApiValidate
  const validateRes = await axios.post(
    `${LOGIN_BASE}/login/1.0/tradeApiValidate`,
    { mpin },
    {
      headers: {
        Authorization: accessToken,
        'neo-fin-key': 'neotradeapi',
        sid: viewSid,
        Auth: viewToken,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }
  );
  console.log('DEBUG tradeApiValidate status:', validateRes.status);
  const sessionToken = validateRes.data.data.token;
  const sessionSid = validateRes.data.data.sid;
  const baseUrl = validateRes.data.data.baseUrl;
  console.log('DEBUG baseUrl:', baseUrl);

  session = {
    token: sessionToken,
    sid: sessionSid,
    baseUrl,
    accessToken,
    expiresAt: Date.now() + 6 * 60 * 60 * 1000, // assume ~6hr validity, refresh if 401
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
    Authorization: s.accessToken,
    'neo-fin-key': 'neotradeapi',
    Auth: s.token,
    Sid: s.sid,
  };
}

// TEST ENDPOINT: verifies login + fetches NIFTY spot quote + shows scripmaster file-paths structure
app.get('/api/test', async (req, res) => {
  try {
    const s = await ensureSession();

    // Fetch spot quote for Nifty 50 index
    const quoteRes = await axios.get(
      `${s.baseUrl}/script-details/1.0/quotes/neosymbol/nse_cm|Nifty 50`,
      { headers: authHeaders(s), timeout: 10000 }
    );
    console.log('DEBUG quote response:', JSON.stringify(quoteRes.data).slice(0, 800));

    // Fetch scripmaster file paths (to inspect structure)
    const scripRes = await axios.get(
      `${s.baseUrl}/script-details/1.0/masterscrip/file-paths`,
      { headers: { Authorization: s.accessToken }, timeout: 10000 }
    );
    console.log('DEBUG scripmaster file-paths:', JSON.stringify(scripRes.data).slice(0, 800));

    res.json({
      status: 'login successful',
      quote: quoteRes.data,
      scripmaster_paths: scripRes.data,
    });
  } catch (err) {
    console.error('Kotak API test failed:', err.response ? JSON.stringify(err.response.data) : err.message);
    res.status(502).json({
      error: 'Kotak API call failed',
      detail: err.response ? err.response.data : err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Vision Option Pro (Kotak Neo) server running on port ${PORT}`);
});
