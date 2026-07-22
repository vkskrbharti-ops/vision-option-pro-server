// Vision Option Pro — Live Data Proxy Server
// Isko apne computer par chalao taaki NSE ka option chain data
// browser ke CORS/bot-protection ko bypass karke fetch ho sake.

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());

let nseCookies = '';
let lastCookieFetch = 0;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.nseindia.com/option-chain',
};

async function refreshCookies() {
  const res = await axios.get('https://www.nseindia.com/option-chain', {
    headers: BROWSER_HEADERS,
    timeout: 10000,
  });
  const setCookie = res.headers['set-cookie'] || [];
  nseCookies = setCookie.map(c => c.split(';')[0]).join('; ');
  lastCookieFetch = Date.now();
}

app.get('/api/option-chain', async (req, res) => {
  const symbol = (req.query.symbol || 'NIFTY').toUpperCase();
  const isIndex = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'].includes(symbol);
  const endpoint = isIndex
    ? `https://www.nseindia.com/api/option-chain-indices?symbol=${symbol}`
    : `https://www.nseindia.com/api/option-chain-equities?symbol=${symbol}`;

  try {
    if (!nseCookies || Date.now() - lastCookieFetch > 4 * 60 * 1000) {
      await refreshCookies();
    }

    const response = await axios.get(endpoint, {
      headers: { ...BROWSER_HEADERS, Cookie: nseCookies },
      timeout: 10000,
    });

    const data = response.data;
    const records = data.records;
    const spot = records.underlyingValue;
    const expiryDates = records.expiryDates;
    const nearestExpiry = expiryDates[0];

    const rows = records.data
      .filter(r => r.expiryDate === nearestExpiry)
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
