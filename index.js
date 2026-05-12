// ─────────────────────────────────────────────────────────────
//  ReachArc — x402 Attention Server
//  Circle Gateway x402 + Session Wallets + Gemini 2.0 Flash
//  Contract: 0x68F4A263d383B419DfdB9f993f84CEC2D613891A
//  Chain: Arc Testnet (5042002)
// ─────────────────────────────────────────────────────────────

require('dotenv').config();
const express    = require('express');
const { ethers } = require('ethers');
const cors       = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors());
app.use(express.json());

// ── CONFIG ────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(process.env.ARC_RPC);
const genAI    = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const gemini   = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

const CONTRACT_ABI = [
  "function registerCreator(uint256,string,string,string) external",
  "function placeBid(address,uint256,string,bool,bytes32) external",
  "function acceptBid(uint256,string) external",
  "function rejectBid(uint256) external",
  "function claimRefund(uint256) external",
  "function getCreator(address) view returns (uint256,bool,uint256,string,string,string,uint256)",
  "function getAllCreators() view returns (address[])",
  "function getCreatorBids(address) view returns (uint256[])",
  "function getBidderBids(address) view returns (uint256[])",
  "function getBid(uint256) view returns (address,address,uint256,string,uint256,uint8,bool,string,bytes32)",
  "function getTopBid(address) view returns (uint256)",
  "function getActiveBidCount(address) view returns (uint256)",
  "event BidPlaced(uint256 indexed,address indexed,address indexed,uint256,bool)",
];

const USDC_ABI = [
  "function approve(address,uint256) external returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) external returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

const contract = new ethers.Contract(
  process.env.CONTRACT_ADDRESS, CONTRACT_ABI, provider
);

const usdcRO = new ethers.Contract(
  process.env.USDC_ADDRESS,
  ["function balanceOf(address) view returns (uint256)"],
  provider
);

// ── HELPERS ───────────────────────────────────────────────────
const fromUsdc = (n) => (Number(n) / 1e6).toFixed(2);

// ── SESSION WALLET STORE ──────────────────────────────────────
// Each tester gets a dedicated wallet — agent spends from it autonomously
const sessions = new Map();
const activeAgents = new Map();

// ── GEMINI EVALUATE ───────────────────────────────────────────
async function evaluateCreator(creator, goal) {
  try {
    const prompt = `You are an autonomous bidder agent on ReachArc.
Goal: "${goal}"
Creator: Name: ${creator.name}, Bio: ${creator.bio}, Tags: ${creator.tags}, Min bid: $${creator.minBidUSD}
Score 1-10 on goal match. Respond ONLY with valid JSON, no markdown:
{"score":7,"reason":"Brief reason","recommendedBidUSD":5,"shouldBid":true}`;
    const result = await gemini.generateContent(prompt);
    const text = result.response.text().trim().replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (e) {
    return { score: 0, shouldBid: false, reason: 'Evaluation failed' };
  }
}

async function scoreWithGemini(message, bio, tags) {
  try {
    const prompt = `You are an AI inbox filter for a creator on ReachArc.
Creator bio: ${bio}
Creator tags: ${tags}
Message: "${message}"
Score 1-10. Respond ONLY with valid JSON:
{"relevance":7,"professionalism":8,"spamRisk":9,"overall":8,"reason":"Brief","recommendation":"ACCEPT"}`;
    const result = await gemini.generateContent(prompt);
    const text = result.response.text().trim().replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (e) {
    return { overall: 5, reason: "Could not score", recommendation: "REVIEW" };
  }
}

// ── ROUTES ────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    name: "ReachArc x402 Server",
    contract: process.env.CONTRACT_ADDRESS,
    chain: "Arc Testnet",
    chainId: parseInt(process.env.CHAIN_ID),
    ai: "Gemini 2.0 Flash",
    sessionWallets: sessions.size,
    activeAgents: activeAgents.size
  });
});

// ── LIST CREATORS ─────────────────────────────────────────────
app.get('/creators', async (req, res) => {
  try {
    const addresses = await contract.getAllCreators();
    const creators = await Promise.all(addresses.map(async (addr) => {
      const [minBid, exists, earned, name, bio, tags] = await contract.getCreator(addr);
      const topBid = await contract.getTopBid(addr);
      const activeBids = await contract.getActiveBidCount(addr);
      return {
        address: addr, name, bio, tags,
        minBidUSD: fromUsdc(minBid),
        totalEarnedUSD: fromUsdc(earned),
        topBidUSD: fromUsdc(topBid),
        activeBids: activeBids.toString(),
        endpoint: `/creator/${addr}`
      };
    }));
    res.json({ count: creators.length, creators });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── x402 CREATOR ENDPOINT ─────────────────────────────────────
app.get('/creator/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    const [minBid, exists,, name, bio, tags] = await contract.getCreator(addr);
    if (!exists) return res.status(404).json({ error: "Creator not found" });

    const paymentHeader = req.headers['x-payment-txhash'] || req.headers['x-payment'];

    if (!paymentHeader) {
      return res.status(402).json({
        x402Version: 1,
        error: "Payment Required",
        accepts: [{
          scheme: "exact",
          network: `eip155:${process.env.CHAIN_ID}`,
          maxAmountRequired: minBid.toString(),
          resource: `${req.protocol}://${req.get('host')}/creator/${req.params.address}`,
          description: `Pay ${fromUsdc(minBid)} USDC to reach ${name} on Arc`,
          mimeType: "application/json",
          payTo: addr,
          maxTimeoutSeconds: 300,
          asset: process.env.USDC_ADDRESS,
          extra: { name: "USD Coin", decimals: 6 }
        }],
        arc: {
          chainId: parseInt(process.env.CHAIN_ID),
          rpc: process.env.ARC_RPC,
          explorer: "https://testnet.arcscan.app",
          contract: process.env.CONTRACT_ADDRESS,
          note: "Arc uses USDC as native gas — no ETH needed"
        },
        creator: { name, bio, tags: tags.split(','), minBidUSD: fromUsdc(minBid) }
      });
    }

    // Verify payment on Arc
    const receipt = await provider.getTransactionReceipt(paymentHeader);
    if (!receipt || receipt.status !== 1) {
      return res.status(402).json({ x402Version: 1, error: "Payment not confirmed on Arc" });
    }

    res.json({
      success: true, x402: "payment_verified",
      creator: { address: addr, name, bio, tags: tags.split(','), minBidUSD: fromUsdc(minBid) },
      access: { messageEndpoint: `POST /message/${req.params.address}`, txHash: paymentHeader }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SESSION WALLET — CREATE ───────────────────────────────────
app.post('/session/create', (req, res) => {
  try {
    // Generate fresh wallet for this tester's agent session
    const sessionWallet = ethers.Wallet.createRandom();
    const sessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    sessions.set(sessionId, {
      id: sessionId,
      address: sessionWallet.address,
      privateKey: sessionWallet.privateKey,
      status: 'awaiting_deposit',
      balance: '0',
      balanceUSD: '0.00',
      createdAt: new Date().toISOString(),
      agentId: null
    });

    console.log(`\n💼 Session created: ${sessionId} → ${sessionWallet.address}`);

    res.json({
      sessionId,
      walletAddress: sessionWallet.address,
      status: 'awaiting_deposit',
      chain: 'Arc Testnet',
      chainId: parseInt(process.env.CHAIN_ID),
      usdc: process.env.USDC_ADDRESS,
      instructions: `Send USDC on Arc Testnet to ${sessionWallet.address}`,
      faucet: 'https://faucet.circle.com',
      explorer: `https://testnet.arcscan.app/address/${sessionWallet.address}`
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SESSION WALLET — STATUS ───────────────────────────────────
app.get('/session/status/:sessionId', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  try {
    const bal = await usdcRO.balanceOf(session.address);
    session.balance = bal.toString();
    session.balanceUSD = fromUsdc(bal);
    session.status = Number(bal) > 0 ? 'funded' : 'awaiting_deposit';
  } catch (e) {}

  const agent = session.agentId ? activeAgents.get(session.agentId) : null;

  res.json({
    sessionId: session.id,
    walletAddress: session.address,
    balanceUSD: session.balanceUSD,
    status: session.status,
    agent: agent ? {
      status: agent.status,
      bidsPlaced: agent.bidsPlaced,
      spent: agent.spent.toFixed(2),
      logs: agent.logs.slice(-5)
    } : null
  });
});

// ── AGENT LAUNCH — FULLY AUTONOMOUS ──────────────────────────
app.post('/agent/launch', async (req, res) => {
  const { sessionId, goal, budget, maxPerBid, minScore, message } = req.body;

  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'funded') {
    return res.status(400).json({
      error: 'Session wallet not funded',
      hint: `Send USDC to ${session.address} on Arc Testnet first`
    });
  }

  const agentId = 'agent_' + Date.now();
  session.agentId = agentId;

  activeAgents.set(agentId, {
    id: agentId,
    sessionId,
    goal,
    budget: parseFloat(budget),
    maxPerBid: parseFloat(maxPerBid || 10),
    minScore: parseInt(minScore || 6),
    message: message || `Hi! I am an autonomous agent. Your profile matched our goal: "${goal}"`,
    status: 'running',
    spent: 0,
    bidsPlaced: 0,
    logs: [],
    startedAt: new Date().toISOString()
  });

  res.json({ agentId, status: 'launched', walletAddress: session.address });

  // Run agent in background — fully autonomous
  runAutonomousAgent(agentId, session).catch(e => {
    const agent = activeAgents.get(agentId);
    if (agent) {
      agent.status = 'error';
      agentLog(agent, 'Fatal error: ' + e.message, 'err');
    }
  });
});

// ── GET AGENT STATUS ──────────────────────────────────────────
app.get('/agent/status/:agentId', (req, res) => {
  const agent = activeAgents.get(req.params.agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agent);
});

// ── STOP AGENT ────────────────────────────────────────────────
app.post('/agent/stop/:agentId', (req, res) => {
  const agent = activeAgents.get(req.params.agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  agent.status = 'stopped';
  agentLog(agent, 'Agent stopped by user', 'warn');
  res.json({ status: 'stopped' });
});

// ── SCORE MESSAGE ─────────────────────────────────────────────
app.post('/score', async (req, res) => {
  try {
    const { message, creatorAddress } = req.body;
    const [,,,, bio, tags] = await contract.getCreator(creatorAddress);
    const score = await scoreWithGemini(message, bio, tags);
    res.json({ score });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── VOICE PARSE ───────────────────────────────────────────────
app.post('/voice-parse', async (req, res) => {
  const { transcript } = req.body;
  if (!transcript) return res.status(400).json({ error: 'No transcript' });
  try {
    const prompt = `Parse this voice command for ReachArc: "${transcript}"
Actions: LAUNCH_AGENT, DISCOVER_CREATORS, REGISTER_CREATOR
Respond ONLY with valid JSON:
{"action":"LAUNCH_AGENT","goal":"find web3 builders","budget":20,"maxPerBid":5,"minScore":6,"confidence":"high"}`;
    const result = await gemini.generateContent(prompt);
    const text = result.response.text().trim().replace(/```json|```/g, '').trim();
    res.json({ intent: JSON.parse(text) });
  } catch (e) {
    res.json({ intent: { action: 'LAUNCH_AGENT', goal: transcript, budget: 20, maxPerBid: 5, minScore: 6, confidence: 'low' } });
  }
});

// ── AGENT RECOMMEND ───────────────────────────────────────────
app.post('/agent/recommend', async (req, res) => {
  const { goal, budget, maxPerBid, minScore } = req.body;
  try {
    const addresses = await contract.getAllCreators();
    const recommendations = [];
    for (const addr of addresses) {
      const [minBid, exists,, name, bio, tags] = await contract.getCreator(addr);
      if (!exists) continue;
      const evaluation = await evaluateCreator({ name, bio, tags, minBidUSD: Number(minBid)/1e6 }, goal);
      if (!evaluation.shouldBid || evaluation.score < parseInt(minScore || 6)) continue;
      const bidAmount = Math.min(
        (evaluation.recommendedBidUSD || 5) * 1e6,
        parseFloat(maxPerBid || 10) * 1e6,
        parseFloat(budget) * 1e6
      );
      recommendations.push({
        creatorAddress: addr, creatorName: name, creatorBio: bio, creatorTags: tags,
        bidAmountUsdc: Math.max(bidAmount, Number(minBid)).toString(),
        bidAmountUSD: fromUsdc(Math.max(bidAmount, Number(minBid))),
        geminiScore: evaluation.score, reason: evaluation.reason,
        message: `Hi ${name}, I'm an autonomous agent. Your profile scored ${evaluation.score}/10 for: "${goal}"`
      });
    }
    res.json({ goal, totalRecommended: recommendations.length, recommendations });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AUTONOMOUS AGENT LOOP ─────────────────────────────────────
function agentLog(agent, msg, type = '') {
  const entry = { time: new Date().toISOString(), msg, type };
  agent.logs.push(entry);
  if (agent.logs.length > 100) agent.logs.shift();
  console.log(`[${agent.id}] ${msg}`);
}

async function runAutonomousAgent(agentId, session) {
  const agent = activeAgents.get(agentId);

  // Create signer from session wallet private key
  const agentWallet   = new ethers.Wallet(session.privateKey, provider);
  const agentContract = new ethers.Contract(process.env.CONTRACT_ADDRESS, CONTRACT_ABI, agentWallet);
  const agentUsdc     = new ethers.Contract(process.env.USDC_ADDRESS, USDC_ABI, agentWallet);

  agentLog(agent, `Agent initialized — wallet: ${session.address}`, 'ok');
  agentLog(agent, `Goal: ${agent.goal}`);
  agentLog(agent, `Budget: $${agent.budget} USDC · Max per bid: $${agent.maxPerBid}`);
  agentLog(agent, `This wallet belongs to your session — not the server`, 'ok');

  // Check USDC balance
  const balance = await agentUsdc.balanceOf(agentWallet.address);
  agentLog(agent, `USDC balance: $${fromUsdc(balance)}`, Number(balance) > 0 ? 'ok' : 'warn');

  const biddedAddresses = new Set();

  while (agent.status === 'running' && agent.spent < agent.budget) {
    agentLog(agent, `Scanning creator registry on Arc...`);

    try {
      const addresses = await contract.getAllCreators();
      agentLog(agent, `Found ${addresses.length} creator(s)`, 'ok');

      for (const addr of addresses) {
        if (agent.status !== 'running') break;
        if (biddedAddresses.has(addr.toLowerCase())) continue;
        if (agent.spent >= agent.budget) break;

        const [minBid, exists,, name, bio, tags] = await contract.getCreator(addr);
        if (!exists) continue;

        agentLog(agent, `Evaluating: ${name} [${tags}]`);

        const evaluation = await evaluateCreator(
          { name, bio, tags, minBidUSD: Number(minBid)/1e6 },
          agent.goal
        );

        agentLog(agent, `Gemini: ${evaluation.score}/10 — ${evaluation.reason}`);

        if (!evaluation.shouldBid || evaluation.score < agent.minScore) {
          agentLog(agent, `Skipping ${name} — score too low`, 'warn');
          continue;
        }

        const bidAmount = Math.min(
          Math.max((evaluation.recommendedBidUSD || agent.maxPerBid) * 1e6, Number(minBid)),
          agent.maxPerBid * 1e6,
          (agent.budget - agent.spent) * 1e6
        );

        if (bidAmount < Number(minBid)) {
          agentLog(agent, `Not enough budget for ${name}`, 'warn');
          continue;
        }

        agentLog(agent, `Approving $${fromUsdc(bidAmount)} USDC from session wallet...`);

        try {
          const approveTx = await agentUsdc.approve(
            process.env.CONTRACT_ADDRESS, BigInt(Math.ceil(bidAmount))
          );
          await approveTx.wait();
          agentLog(agent, `USDC approved from YOUR session wallet`, 'ok');

          const bidTx = await agentContract.placeBid(
            addr, BigInt(Math.ceil(bidAmount)),
            agent.message, false, ethers.ZeroHash
          );
          const receipt = await bidTx.wait();

          biddedAddresses.add(addr.toLowerCase());
          agent.spent += bidAmount / 1e6;
          agent.bidsPlaced++;

          agentLog(agent, `✓ Bid placed on ${name}! Tx: ${receipt.hash.slice(0,20)}...`, 'ok');
          agentLog(agent, `Spent: $${agent.spent.toFixed(2)} / $${agent.budget}`, 'ok');

        } catch (e) {
          agentLog(agent, `Bid failed: ${e.reason || e.message}`, 'err');
        }

        await new Promise(r => setTimeout(r, 3000));
      }

    } catch (e) {
      agentLog(agent, `Scan error: ${e.message}`, 'err');
    }

    if (agent.status === 'running') {
      agentLog(agent, `Scan complete. Next scan in 60 seconds...`);
      await new Promise(r => setTimeout(r, 60000));
    }
  }

  agent.status = agent.spent >= agent.budget ? 'budget_exhausted' : 'stopped';
  agentLog(agent, `Done. Spent: $${agent.spent.toFixed(2)}, Bids: ${agent.bidsPlaced}`, 'ok');
}

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   ReachArc — x402 Server  ·  Arc Testnet        ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`\n  Server:   http://localhost:${PORT}`);
  console.log(`  Contract: ${process.env.CONTRACT_ADDRESS}`);
  console.log(`  AI:       Gemini 2.0 Flash`);
  console.log('\n  Waiting for agents...\n');
});
