// Vision Option Pro — Live Data Proxy Server
// Isko apne computer par chalao taaki NSE ka option chain data
// browser ke CORS/bot-protection ko bypass karke fetch ho sake.
//
// Setup:
//   1) Node.js install karo (nodejs.org) agar pehle se nahi hai
//   2) Is folder me terminal khol ke: npm install
//   3) Phir chalao: node server.js
//   4) Browser me dashboard kholo — woh http://localhost:5000 se live data lega
//
// NOTE: NSE apna anti-bot protection samay-samay par change karta rehta hai.
// Agar yeh kabhi 401/403 error de, to NSE ne unka protection update kiya hai —
// tab headers/cookie-refresh logic update karni padegi.

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());

let nseCookies = '';
let lastCookieFetch = 0;

const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

const NAV_HEADERS = {
  ...BASE_HEADERS,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'Upgrade-Insecure-Requests': '1',
};

const XHR_HEADERS = {
  ...BASE_HEADERS,
  'Accept': '*/*',
  'Referer': 'https://www.nseindia.com/option-chain',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'X-Requested-With': 'XMLHttpRequest',
};

async function refreshCookies() {
  const res = await axios.get('https://www.nseindia.com/option-chain', {
    headers: NAV_HEADERS,
    timeout: 10000,
  });
  const setCookie = res.headers['set-cookie'] || [];
  nseCookies = setCookie.map(c => c.split(';')[0]).join('; ');
  lastCookieFetch = Date.now();
}

app.get('/api/option-chain', async (req, res) => {
  const symbol = (req.query.symbol || 'NIFTY').toUpperCase();
  const isIndex = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'].includes(symbol);
  const type = isIndex ? 'Indices' : 'Equity';

  try {
    if (!nseCookies || Date.now() - lastCookieFetch > 4 * 60 * 1000) {
      await refreshCookies();
    }
    console.log('DEBUG cookies length:', nseCookies.length);

    const headers = { ...XHR_HEADERS, Cookie: nseCookies };

    const firstCall = await axios.get(
      `https://www.nseindia.com/api/option-chain-v3?type=${type}&symbol=${symbol}`,
      { headers, timeout: 10000 }
    );
    console.log('DEBUG firstCall status:', firstCall.status);
    console.log('DEBUG firstCall data (first 500 chars):', JSON.stringify(firstCall.data).slice(0, 500));
    const records = firstCall.data.records;
    const spot = records.underlyingValue;
    const expiryDates = records.expiryDates;
    const nearestExpiry = expiryDates[0];

    const secondCall = await axios.get(
      `https://www.nseindia.com/api/option-chain-v3?type=${type}&symbol=${symbol}&expiry=${nearestExpiry}`,
      { headers, timeout: 10000 }
    );
    const records2 = secondCall.data.records;

    const rows = records2.data
      .map(r => ({
        strike: r.strikePrice,
        callOI: r.CE ? r.CE.openInterest : 0,
        callOIChange: r.CE ? r.CE.changeinOpenInterest : 0,
        callVol: r.CE ? r.CE.totalTradedVolume : 0,
        callLTP: r.CE ? r.CE.lastPrice : 0,
        callIV: r.CE ? r.CE.impliedVolatility : 0,
        putOI: r.PE ? r.PE.openInterest : 0,
        putOIChange: r.PE ? r.PE.changeinOpenInterest : 0,
        putVol: r.PE ? r.PE.totalTradedVolume : 0,
        putLTP: r.PE ? r.PE.lastPrice : 0,
        putIV: r.PE ? r.PE.impliedVolatility : 0,
      }))
      .sort((a, b) => a.strike - b.strike);

    res.json({
      symbol,
      spot,
      expiry: nearestExpiry,
      timestamp: new Date().toISOString(),
      rows,
    });
  } catch (err) {
    console.error('NSE fetch failed:', err.message);
    res.status(502).json({
      error: 'Failed to fetch live data from NSE. It may be rate-limiting or has changed its protection — try again in a few seconds.',
      detail: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Vision Option Pro live-data server running: http://localhost:${PORT}`);
  console.log(`Try it: http://localhost:${PORT}/api/option-chain?symbol=NIFTY`);
});
