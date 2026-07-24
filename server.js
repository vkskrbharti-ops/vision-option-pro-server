// Vision Option Pro — Angel One SmartAPI Live Data Server
//
// Credentials from Render Environment tab:
//   ANGEL_CLIENT_CODE, ANGEL_MPIN, ANGEL_API_KEY, ANGEL_TOTP_SECRET

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { authenticator } = require('otplib');

const app = express();
const PORT = process.env.PORT || 5000;
app.use(cors());

const API_BASE = 'https://apiconnect.angelbroking.com';
const INSTRUMENT_MASTER_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
const NIFTY_SPOT_TOKEN = '99926000';

let session = null;
let instrumentCache = null;

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

  const loginRes = await axios.post(
    `${API_BASE}/rest/auth/angelbroking/user/v1/loginByPassword`,
    { clientcode, password: mpin, totp },
    { headers: commonHeaders(apiKey), timeout: 10000 }
  );

  if (!loginRes.data.status) {
    throw new Error('Login failed: ' + JSON.stringify(loginRes.data));
  }

  session = {
    jwtToken: loginRes.data.data.jwtToken,
    feedToken: loginRes.data.data.feedToken,
    apiKey,
    clientcode,
    expiresAt: Date.now() + 5 * 60 * 60 * 1000,
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
  return res.data;
}

function parseExpiry(expiryStr) {
  // Format: "11AUG2026"
  const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
  const day = parseInt(expiryStr.slice(0, 2), 10);
  const mon = months[expiryStr.slice(2, 5).toUpperCase()];
  const year = parseInt(expiryStr.slice(5), 10);
  return new Date(year, mon, day);
}

async function fetchQuotes(s, tokensByExchange) {
  const res = await axios.post(
    `${API_BASE}/rest/secure/angelbroking/market/v1/quote/`,
    { mode: 'FULL', exchangeTokens: tokensByExchange },
    { headers: authHeaders(s), timeout: 15000 }
  );
  return res.data;
}

// Map instrument type (frontend) -> Angel One exch_seg + option instrumenttype + spot exch_seg
function getSegmentConfig(type){
  if(type === 'MCX') return { optSeg: 'MCX', optInstType: 'OPTFUT', spotSeg: 'MCX' };
  if(type === 'STOCK') return { optSeg: 'NFO', optInstType: 'OPTSTK', spotSeg: 'NSE' };
  return { optSeg: 'NFO', optInstType: 'OPTIDX', spotSeg: 'NSE' }; // INDEX default
}

function findSpotToken(instruments, symbol, type, cfg){
  if(type === 'MCX'){
    // For MCX, use the nearest-expiry futures contract as the reference price (no separate spot index)
    const futs = instruments.filter(i => i.name === symbol && i.exch_seg === 'MCX' && i.instrumenttype === 'FUTCOM');
    if(futs.length === 0) return null;
    const today = new Date();
    const sorted = futs.map(f => ({...f, expDate: parseExpiry(f.expiry)})).filter(f=>f.expDate>=today).sort((a,b)=>a.expDate-b.expDate);
    return sorted[0] ? sorted[0].token : null;
  }
  if(type === 'STOCK'){
    const eq = instruments.find(i => i.exch_seg === 'NSE' && i.symbol === `${symbol}-EQ`);
    return eq ? eq.token : null;
  }
  // INDEX: match common name variants
  const idx = instruments.find(i => i.exch_seg === 'NSE' &&
    (i.symbol || '').replace(/\s+/g,'').toUpperCase() === symbol.toUpperCase());
  return idx ? idx.token : null;
}

app.get('/api/option-chain', async (req, res) => {
  try {
    const range = parseInt(req.query.range) || 5;
    const symbol = (req.query.symbol || 'NIFTY').toUpperCase();
    const type = (req.query.type || 'INDEX').toUpperCase();
    const cfg = getSegmentConfig(type);

    const s = await ensureSession();
    const instruments = await getInstrumentMaster();

    // 1. Get spot/reference price
    const spotToken = findSpotToken(instruments, symbol, type, cfg);
    if(!spotToken){
      return res.status(404).json({ error: `Could not find instrument for ${symbol} (${type}) in instrument master` });
    }
    const spotRes = await fetchQuotes(s, { [cfg.spotSeg]: [spotToken] });
    const spotData = spotRes.data.fetched.find((f) => f.symbolToken === spotToken);
    const spot = spotData ? spotData.ltp : null;

    if (!spot) {
      return res.status(502).json({ error: 'Could not fetch spot/reference price', detail: spotRes });
    }

    // 2. Find option contracts for this symbol, nearest expiry
    const allOptions = instruments.filter(
      (i) => i.name === symbol && i.exch_seg === cfg.optSeg && i.instrumenttype === cfg.optInstType
    );
    if(allOptions.length === 0){
      return res.status(404).json({ error: `No option contracts found for ${symbol} (${type})` });
    }
    const today = new Date();
    const expiries = [...new Set(allOptions.map((o) => o.expiry))]
      .map((e) => ({ str: e, date: parseExpiry(e) }))
      .filter((e) => e.date >= today)
      .sort((a, b) => a.date - b.date);
    const nearestExpiry = expiries[0].str;

    const contractsThisExpiry = allOptions.filter((o) => o.expiry === nearestExpiry);

    // 3. Determine ATM and strike range (step auto-detected from listed strikes' spacing)
    const uniqueStrikes = [...new Set(contractsThisExpiry.map(c => parseFloat(c.strike)/100))].sort((a,b)=>a-b);
    let step = 50;
    if(uniqueStrikes.length > 1){
      const diffs = uniqueStrikes.slice(1).map((v,i)=>v-uniqueStrikes[i]);
      step = Math.min(...diffs);
    }
    const atm = Math.round(spot / step) * step;
    const wantedStrikes = [];
    for (let i = -range; i <= range; i++) wantedStrikes.push(atm + i * step);

    const relevantContracts = contractsThisExpiry.filter((c) => {
      const strikeVal = parseFloat(c.strike) / 100;
      return wantedStrikes.includes(strikeVal);
    });

    const tokens = relevantContracts.map((c) => c.token);
    const chunkSize = 50;
    let allFetched = [];
    for (let i = 0; i < tokens.length; i += chunkSize) {
      const chunk = tokens.slice(i, i + chunkSize);
      const qRes = await fetchQuotes(s, { [cfg.optSeg]: chunk });
      if (qRes.data && qRes.data.fetched) allFetched = allFetched.concat(qRes.data.fetched);
    }

    // 4. Build rows: for each strike, find CE and PE contract + quote
    const rows = wantedStrikes.map((K) => {
      const ceContract = relevantContracts.find((c) => parseFloat(c.strike) / 100 === K && c.symbol.endsWith('CE'));
      const peContract = relevantContracts.find((c) => parseFloat(c.strike) / 100 === K && c.symbol.endsWith('PE'));
      const ceQuote = ceContract ? allFetched.find((f) => f.symbolToken === ceContract.token) : null;
      const peQuote = peContract ? allFetched.find((f) => f.symbolToken === peContract.token) : null;

      return {
        strike: K,
        callOI: ceQuote ? ceQuote.opnInterest : 0,
        callVol: ceQuote ? ceQuote.tradeVolume : 0,
        callLTP: ceQuote ? ceQuote.ltp : 0,
        callChange: ceQuote ? ceQuote.netChange : 0,
        putOI: peQuote ? peQuote.opnInterest : 0,
        putVol: peQuote ? peQuote.tradeVolume : 0,
        putLTP: peQuote ? peQuote.ltp : 0,
        putChange: peQuote ? peQuote.netChange : 0,
      };
    });

    res.json({
      symbol,
      type,
      spot,
      expiry: nearestExpiry,
      atm,
      step,
      timestamp: new Date().toISOString(),
      rows,
    });
  } catch (err) {
    console.error('Option chain fetch failed:', err.response ? JSON.stringify(err.response.data) : err.message);
    res.status(502).json({
      error: 'Failed to fetch option chain',
      detail: err.response ? err.response.data : err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Vision Option Pro (Angel One) server running on port ${PORT}`);
});
