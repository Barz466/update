const { Telegraf, Markup, session } = require("telegraf");
const axios = require("axios");
const chalk = require("chalk");
const fs = require("fs");
const path = require("path");
const qs = require("querystring");
const FormData = require("form-data");
const archiver = require("archiver");
const readline = require("readline");
const QRCode = require("qrcode");
const config = require("./config");
const { createdQris, cekStatus, toRupiah } = require("./lib/payment");

const bot = new Telegraf(config.botToken);
bot.use(session());

const globalNokos = {
  cachedServices: [],
  cachedCountries: {},
  lastServicePhoto: {},
  activeOrders: {}
};

function isPrivateChat(ctx) {
  return ctx.chat.type === 'private';
}

async function notifyOwnerNewUser(user) {
  try {
    const username = user.username ? `@${user.username}` : "-"
    const name = `${user.first_name || ""} ${user.last_name || ""}`.trim()
    const time = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
    
    const users = loadUsers()
    const totalUsers = users.length

    const text = `👤 <b>USER BARU TERDETEKSI</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `<b>Nama :</b> ${name}\n` +
      `<b>Username :</b> ${username}\n` +
      `<b>ID :</b> <code>${user.id}</code>\n` +
      `<b>Waktu :</b> ${time}\n\n` +
      `📊 <b>Total User:</b> ${totalUsers}`

    await bot.telegram.sendMessage(config.ownerId, text, { parse_mode: "HTML" })
  } catch (e) {
    console.log(e)
  }
}

async function requirePrivateChat(ctx, actionName) {
  if (!isPrivateChat(ctx)) {
    await ctx.answerCbQuery("❌ Perintah ini hanya bisa digunakan di Private Chat!", { show_alert: true });
    
    try {
      await ctx.reply("🚫 𝗙𝗜𝗧𝗨𝗥 𝗧𝗜𝗗𝗔𝗞 𝗕𝗜𝗦𝗔 𝗗𝗜𝗚𝗨𝗡𝗔𝗞𝗔𝗡!\n━━━━━━━━━━━━━━━━━━━━❍\n🚀 𝗛𝗮𝗻𝘆𝗮 𝗕𝗶𝘀𝗮 𝗗𝗶𝗴𝘂𝗻𝗮𝗸𝗮𝗻 𝗗𝗶\n𝗣𝗿𝗶𝘃𝗮𝘁𝗲 𝗖𝗵𝗮𝘁 𝗕𝗼𝘁!:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🌸 𝗖𝗵𝗮𝘁 𝗕𝗼𝘁 𝗦𝗲𝗸𝗮𝗿𝗮𝗻𝗴", url: `https://t.me/${bot.botInfo.username}` }]
          ]
        }
      });
    } catch (e) {}
    
    return false;
  }
  return true;
}

async function getDropletCount() {
  try {
    const apiDO = config.ApiDO1;
    if (!apiDO || apiDO === "-") return 0;

    const res = await axios.get("https://api.digitalocean.com/v2/droplets", {
      headers: { Authorization: `Bearer ${apiDO}` }
    });

    return res.data.droplets?.length || 0;
  } catch (e) {
    console.error("Error checking droplet count:", e.message);
    return 0;
  }
}

async function createVPSDroplet(userId, vpsData) {
  try {
    const apiDO = config.ApiDO1;
    if (!apiDO) {
      return { success: false, msg: "API KEY DigitalOcean tidak ditemukan!" };
    }

    const sizeMap = {
      "2c2": "s-2vcpu-2gb-amd",
      "4c2": "s-2vcpu-4gb-amd",
      "8c4": "s-4vcpu-8gb-amd",
      "16c4": "s-4vcpu-16gb-amd",
      "16c8": "s-8vcpu-16gb-amd"
    };

    const size = sizeMap[vpsData.plan];
    if (!size) {
      return { success: false, msg: "PLAN VPS TIDAK VALID!" };
    }

    const osShort = (vpsData.osFamily || "ubuntu").toLowerCase();
    const regionShort = (vpsData.region || "sgp1").toLowerCase();
    const planShort = (vpsData.plan || "2c2").toLowerCase();
    const urut = String(Math.floor(Math.random() * 90) + 10);
    const hostname = `${osShort}-${planShort}-${regionShort}-${urut}`;
    const password = `${config.CostumPassVps}` + size.replace(/s-|-/g, "").toUpperCase();

    const payload = {
      name: hostname,
      region: vpsData.region,
      size: size,
      image: vpsData.os,
      ipv6: true,
      backups: false,
      tags: ["order-BuyVPS"],
      user_data: `#cloud-config
password: ${password}
chpasswd: { expire: False }`
    };

    console.log("Creating VPS with payload:", JSON.stringify(payload, null, 2));

    const resp = await axios.post("https://api.digitalocean.com/v2/droplets", payload, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiDO}`
      },
      timeout: 30000
    });

    if (resp.status !== 202) {
      return { success: false, msg: "Gagal membuat VPS: " + JSON.stringify(resp.data) };
    }

    const dropletId = resp.data.droplet.id;
    console.log(`VPS Created - ID: ${dropletId}, Hostname: ${hostname}`);

    await new Promise(r => setTimeout(r, 60000));

    const cek = await axios.get(`https://api.digitalocean.com/v2/droplets/${dropletId}`, {
      headers: { "Authorization": `Bearer ${apiDO}` },
      timeout: 10000
    });

    const dropletInfo = cek.data.droplet;
    const ip = dropletInfo?.networks?.v4?.[0]?.ip_address || "N/A";
    
    console.log(`VPS IP: ${ip}`);

    const vpsFolder = "./database";
    const vpsPath = `${vpsFolder}/data_vps.json`;

    if (!fs.existsSync(vpsFolder)) {
      fs.mkdirSync(vpsFolder, { recursive: true });
    }

    if (!fs.existsSync(vpsPath)) {
      fs.writeFileSync(vpsPath, JSON.stringify([], null, 2));
    }

    let vpsDB = [];
    try {
      vpsDB = JSON.parse(fs.readFileSync(vpsPath));
      if (!Array.isArray(vpsDB)) vpsDB = [];
    } catch (err) {
      vpsDB = [];
    }

    const created = new Date().toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });

    const paketInfo = {
      low: { garansi: 7, replace: 1 },
      medium: { garansi: 15, replace: 2 },
      high: { garansi: 30, replace: -1 }
    };

    const newVpsData = {
      userId: userId,
      username: vpsData.username || "-",
      hostname: hostname,
      ip: ip,
      password: password,
      region: vpsData.region,
      osFamily: vpsData.osFamily,
      os: vpsData.os,
      paket: vpsData.paket,
      plan: vpsData.plan,
      garansi: paketInfo[vpsData.paket]?.garansi || 7,
      replace: paketInfo[vpsData.paket]?.replace || 1,
      harga: vpsData.harga,
      dropletId: dropletId,
      created: created,
      penjual: bot.botInfo.username
    };

    vpsDB.push(newVpsData);
    fs.writeFileSync(vpsPath, JSON.stringify(vpsDB, null, 2));

    return {
      success: true,
      data: {
        hostname,
        ip,
        password,
        region: vpsData.region,
        os: vpsData.os,
        plan: vpsData.plan,
        garansi: paketInfo[vpsData.paket]?.garansi || 7,
        replace: paketInfo[vpsData.paket]?.replace || 1,
        created
      }
    };

  } catch (error) {
    console.error("Error creating VPS:", error);
    return { 
      success: false, 
      msg: error.response?.data?.message || error.message || "Unknown error" 
    };
  }
}

async function atlanticTransfer(nominal, config, note = "Withdraw Saldo Bot") {
  try {
    const reffId = `wd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const body = {
      api_key: config.apiAtlantic,
      ref_id: reffId,
      kode_bank: config.wd_balance.bank_code,
      nomor_akun: config.wd_balance.destination_number,
      nama_pemilik: config.wd_balance.destination_name,
      nominal: Number(nominal),
      email: "bot@telegram.com",
      phone: config.wd_balance.destination_number,
      note: note
    };

    const response = await axios.post("https://atlantich2h.com/transfer/create", qs.stringify(body), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000
    });

    return response.data;
  } catch (error) {
    throw new Error(`Gagal membuat transfer: ${error.message}`);
  }
}

async function atlanticTransferStatus(transferId, api_key) {
  const body = { api_key, id: String(transferId) };
  const response = await axios.post("https://atlantich2h.com/transfer/status", qs.stringify(body), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });
  return response.data;
}

async function editMenuMessage(ctx, text, keyboard) {
  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      ...keyboard
    });
  } catch (e) {
    try {
      const newMsg = await safeReply(ctx, text, {
        parse_mode: "HTML",
        ...keyboard
      });
      
      try {
        if (ctx.callbackQuery) {
          await ctx.deleteMessage();
        }
      } catch (err) {}
      
      return newMsg;
    } catch (replyErr) {
      console.error("Edit menu error:", replyErr);
      return null;
    }
  }
}

async function editMenuMessageWithPhoto(ctx, photo, caption, keyboard) {
  try {
    await ctx.editMessageMedia({
      type: 'photo',
      media: photo,
      caption: caption,
      parse_mode: 'HTML'
    }, {
      parse_mode: "HTML",
      ...keyboard
    });
  } catch (e) {
    try {
      try {
        if (ctx.callbackQuery) {
          await ctx.deleteMessage();
        }
      } catch (err) {}
      
      await ctx.replyWithPhoto(photo, {
        caption: caption,
        parse_mode: "HTML",
        ...keyboard
      });
    } catch (replyErr) {
      console.error("Edit menu with photo error:", replyErr);
      return null;
    }
  }
}

async function safeSend(method, chatId, ...args) {
  try {
    return await bot.telegram[method](chatId, ...args);
  } catch (err) {
    const m = err?.response?.description || err?.description || err?.message || String(err);
    if (typeof m === 'string' && (m.toLowerCase().includes('user is deactivated') || m.toLowerCase().includes('bot was blocked') || m.toLowerCase().includes('blocked'))) {
      return null;
    }
    throw err;
  }
}

async function safeReply(ctx, text, extra = {}) {
  try {
    return await ctx.reply(text, extra);
  } catch (err) {
    const m = err?.response?.description || err?.description || err?.message || String(err);
    if (typeof m === 'string' && (m.toLowerCase().includes('user is deactivated') || m.toLowerCase().includes('bot was blocked') || m.toLowerCase().includes('blocked'))) {
      return null;
    }
    throw err;
  }
}

const USERS_DB = "./users.json";
const DB_PATH = "./database.json";
const MANUAL_PAYMENTS_DB = "./manual_payments.json";
const activeTransactions = {};
const userState = {};
const liveChatState = {};
const ownerReplyState = {};
const SMM_HISTORY_DB = "./database/smm_history.json";

function getSmmHistory(userId) {
  if (!fs.existsSync(SMM_HISTORY_DB)) fs.writeFileSync(SMM_HISTORY_DB, JSON.stringify({}));
  const db = JSON.parse(fs.readFileSync(SMM_HISTORY_DB));
  return db[userId] || [];
}

function saveSmmHistory(userId, orderData) {
  const db = JSON.parse(fs.readFileSync(SMM_HISTORY_DB));
  if (!db[userId]) db[userId] = [];
  db[userId].unshift(orderData); 
  fs.writeFileSync(SMM_HISTORY_DB, JSON.stringify(db, null, 2));
}

async function callSmmApi(path, params = {}) {
  try {
    const requestBody = {
        api_id: config.smm.apiId,
        api_key: config.smm.apiKey,
        ...params
    };

    const response = await axios.post(`${config.smm.baseUrl}${path}`, requestBody, {
        headers: { 'Content-Type': 'application/json' }
    });
    
    return response.data;
  } catch (e) {
    console.error("SMM API Error:", e.message);
    return { status: false, msg: "Gagal connect ke server SMM" };
  }
}

let botStartTime = Date.now();

const TESTIMONI_CHANNEL = config.testimoniChannel || "";

async function createAndSendFullBackup(ctx = null, isAuto = false) {
  const timestamp = new Date().toLocaleString("id-ID", { 
    timeZone: "Asia/Jakarta" 
  }).replace(/[\/:]/g, '-').replace(/, /g, '_');
  
  const backupName = `${config.botName || 'Bot'}_${timestamp}.zip`;
  const backupPath = path.join(__dirname, backupName);
  const output = fs.createWriteStream(backupPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  console.log(`[BACKUP] Memulai proses zip full SC...`);

  return new Promise((resolve, reject) => {
    output.on('close', async () => {
      console.log(`[BACKUP] Selesai. Size: ${(archive.pointer() / 1024 / 1024).toFixed(2)} MB`);
      
      try {
        const caption = isAuto 
          ? `♻️ <b>AUTO BACKUP SC</b>\n📅 ${timestamp}`
          : `📦 <b>BACKUP SOURCE CODE</b>\n📅 ${timestamp}`;

        await bot.telegram.sendDocument(config.ownerId, {
          source: backupPath,
          filename: backupName
        }, { caption: caption, parse_mode: "HTML" });

        fs.unlinkSync(backupPath);
        if (ctx) await ctx.reply("✅ <b>Backup SC Terkirim ke Owner!</b>", { parse_mode: "HTML" });
        resolve(true);
      } catch (err) {
        console.error("[BACKUP FAIL]", err);
        if (ctx) await ctx.reply("❌ Gagal kirim backup.");
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
        reject(err);
      }
    });

    archive.on('error', (err) => reject(err));
    archive.pipe(output);

    archive.glob('**/*', {
      cwd: __dirname,
      ignore: [
        'node_modules/**',
        '.git/**',
        'session.json',
        '*.zip',
        'backups/**'
      ]
    });

    archive.finalize();
  });
}

async function generateLocalQr(qrString) {
  try {
    return await QRCode.toBuffer(qrString, {
      type: 'png',
      width: 400,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
  } catch (err) {
    console.error("QR Generate Error:", err);
    return null;
  }
}

async function sendTestimoniKeChannel(userName, userId, productName, amount) {
  try {
    if (!TESTIMONI_CHANNEL) {
      console.log("[INFO] Channel testimoni belum diatur di config.js");
      return;
    }

    const now = new Date();
    const options = { 
      timeZone: 'Asia/Jakarta', 
      weekday: 'long',
      year: 'numeric', 
      month: 'long', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    };
    const waktuWIB = now.toLocaleString('id-ID', options);

    const testimoniText = `
📜 𝗦𝗧𝗥𝗨𝗞 𝗣𝗘𝗠𝗕𝗘𝗟𝗜𝗔𝗡 𝗣𝗥𝗢𝗗𝗨𝗞
━━━━━━━━━━━━━━━━━━━━━⨳
🪪 𝗜𝗗𝗘𝗡𝗧𝗜𝗧𝗔𝗦 𝗣𝗘𝗠𝗕𝗘𝗟𝗜
├⌑ 👤 𝗡𝗮𝗺𝗮 : ${userName}
╰⌑ 🆔 𝗜𝗗 : ${userId}

🎀 𝗗𝗔𝗧𝗔 𝗣𝗥𝗢𝗗𝗨𝗞
├⌑ 🛒 𝗣𝗿𝗼𝗱𝘂𝗸 : ${productName}
├⌑ 💰 𝗛𝗮𝗿𝗴𝗮 : ${toRupiah(amount)}
╰⌑ ⏰ 𝗪𝗮𝗸𝘁𝘂 : ${waktuWIB} WIB

📨 𝗧𝗲𝗿𝗶𝗺𝗮𝗸𝗮𝘀𝗶𝗵 𝗦𝘂𝗱𝗮𝗵 𝗕𝗲𝗹𝗮𝗻𝗷𝗮 𝗗𝗶 :
 ➥ ${config.botName} 𝗕𝗼𝘁
    `;

    await bot.telegram.sendMessage(TESTIMONI_CHANNEL, testimoniText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🛒 𝗢𝗿𝗱𝗲𝗿 𝗦𝗲𝗸𝗮𝗿𝗮𝗻𝗴", url: `https://t.me/${bot.botInfo.username}` }]
        ]
      }
    });

    console.log("[SUCCESS] Testimoni berhasil dikirim ke channel");
  } catch (error) {
    console.error("[ERROR] Gagal mengirim testimoni ke channel:", error.message);
    console.log("[INFO] Pastikan bot sudah jadi admin di channel:", TESTIMONI_CHANNEL);
  }
}

function readManualPayments() {
  if (!fs.existsSync(MANUAL_PAYMENTS_DB)) {
    fs.writeFileSync(MANUAL_PAYMENTS_DB, JSON.stringify([]));
  }
  return JSON.parse(fs.readFileSync(MANUAL_PAYMENTS_DB));
}

function saveManualPayments(data) {
  fs.writeFileSync(MANUAL_PAYMENTS_DB, JSON.stringify(data, null, 2));
}

function getBotStats() {
  try {
    const users = loadUsers();
    const totalUsers = users.length;

    const uptime = Date.now() - botStartTime;
    const days = Math.floor(uptime / (1000 * 60 * 60 * 24));
    const hours = Math.floor((uptime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));

    return {
      totalUsers,
      runtime: `${days}d ${hours}h ${minutes}m`,
      botName: config.botName || "BOT TELEGRAM",
      ownerName: config.ownerName || "Owner",
      backupCount: "Auto" 
    };
  } catch (e) {
    return {
      totalUsers: "Error",
      runtime: "Unknown",
      botName: config.botName || "BOT TELEGRAM",
      ownerName: config.ownerName || "Owner",
      backupCount: "-"
    };
  }
}

function formatUserCard(ctx, msg) {
  const username = ctx.from.username ? `@${ctx.from.username}` : '-';
  return `<b>📩 PESAN DARI USER</b>\n<b>Username :</b> ${username}\n<b>ID User  :</b> ${ctx.from.id}\n\n<b>Pesan:</b>\n${msg}`;
}

bot.on("document", async (ctx, next) => {
  const userId = ctx.from.id;
  const state = userState[userId];

  if (state?.step === "WAITING_SCRIPT_FILE" && userId === config.ownerId) {
    const doc = ctx.message.document;

    if (!doc.file_name.endsWith(".zip"))
      return safeReply(ctx, "<blockquote>❌ File harus format .zip!</blockquote>", { parse_mode: "HTML" });

    userState[userId] = {
      step: "WAITING_SCRIPT_DETAIL",
      file_id: doc.file_id,
      temp_fileName: doc.file_name.replace(/\s/g, "_"),
    };

    return safeReply(ctx, `<blockquote>✅ <b>File diterima!</b>\n<b>Kirim detail:</b>\nNama | Harga | Deskripsi</blockquote>`, { parse_mode: "HTML" });
  }

  return next();
});

bot.command("pesan", async (ctx) => {
  const raw = ctx.message.text || "";
  const msg = raw.replace(/^\/pesan(@\w+)?\s*/i, "").trim();

  if (!msg) {
    liveChatState[ctx.from.id] = { step: "WAITING_MESSAGE" };
    return safeReply(ctx, "📝 <b>𝗦𝗶𝗹𝗮𝗵𝗸𝗮𝗻 𝗞𝗲𝘁𝗶𝗸 𝗣𝗲𝘀𝗮𝗻 𝗔𝗻𝗱𝗮 𝗨𝗻𝘁𝘂𝗸 𝗗𝗶𝗸𝗶𝗿𝗶𝗺 𝗞𝗲 𝗢𝘄𝗻𝗲𝗿 𝗕𝗼𝘁.</b>\n❌ 𝗞𝗲𝘁𝗶𝗸 /batal 𝗨𝗻𝘁𝘂𝗸 𝗠𝗲𝗺𝗯𝗮𝘁𝗮𝗹𝗸𝗮𝗻 𝗠𝗲𝗻𝗴𝗶𝗿𝗶𝗺 𝗣𝗲𝘀𝗮𝗻", { parse_mode: "HTML" });
  }

  return sendToOwner(ctx, msg);
});

bot.command("batal", (ctx) => {
  if (liveChatState[ctx.from.id]?.step === "WAITING_MESSAGE") {
    delete liveChatState[ctx.from.id];
    return safeReply(ctx, "❌ 𝗣𝗲𝗻𝗴𝗶𝗿𝗶𝗺𝗮𝗻 𝗣𝗲𝘀𝗮𝗻 𝗕𝗲𝗿𝗵𝗮𝘀𝗶𝗹 𝗗𝗶𝗯𝗮𝘁𝗮𝗹𝗸𝗮𝗻.");
  }
  if (ownerReplyState[ctx.from.id]) {
    delete ownerReplyState[ctx.from.id];
    return safeReply(ctx, "❌ 𝗠𝗼𝗱𝗲 𝗕𝗮𝗹𝗮𝘀𝗮𝗻 𝗢𝘄𝗻𝗲𝗿 𝗗𝗶𝗵𝗲𝗻𝘁𝗶𝗸𝗮𝗻.");
  }
  if (userState[ctx.from.id]?.step === "WAITING_BROADCAST" && ctx.from.id === config.ownerId) {
    delete userState[ctx.from.id];
    return safeReply(ctx, "❌ 𝗕𝗿𝗼𝗮𝗱𝗰𝗮𝘀𝘁 𝗗𝗶𝗯𝗮𝘁𝗮𝗹𝗸𝗮𝗻.");
  }
  return; 
});

bot.on("text", async (ctx, next) => {
  try {
    const st = liveChatState[ctx.from.id];
    if (st && st.step === "WAITING_MESSAGE") {
      const text = ctx.message.text;
      delete liveChatState[ctx.from.id];
      return await sendToOwner(ctx, text);
    }
  } catch (e) {}
  return next();
});

async function sendToOwner(ctx, messageText) {
  try {
    const owner = config.ownerId;
    const layout = formatUserCard(ctx, messageText);
    await bot.telegram.sendMessage(owner, layout, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📨 𝗕𝗮𝗹𝗮𝘀 𝗣𝗲𝘀𝗮𝗻 𝗨𝘀𝗲𝗿", callback_data: `reply_${ctx.from.id}` }]
        ]
      }
    });
    await safeReply(ctx, "✅ <b>𝗣𝗲𝘀𝗮𝗻 𝗕𝗲𝗿𝗵𝗮𝘀𝗶𝗹 𝗗𝗶𝗸𝗶𝗿𝗶𝗺𝗸𝗮𝗻 𝗞𝗲𝗽𝗮𝗱𝗮 𝗢𝘄𝗻𝗲𝗿 𝗕𝗼𝘁.</b>", { parse_mode: "HTML" });
  } catch (err) {
    return safeReply(ctx, "❌ 𝗣𝗲𝗻𝗴𝗶𝗿𝗶𝗺𝗮𝗻 𝗣𝗲𝘀𝗮𝗻 𝗚𝗮𝗴𝗮𝗹, 𝗧𝗲𝗿𝗷𝗮𝗱𝗶 𝗘𝗿𝗿𝗼𝗿 𝗦𝗶𝘀𝘁𝗲𝗺.");
  }
}

bot.action(/reply_(\d+)/, async (ctx) => {
  try {
    if (String(ctx.from.id) !== String(config.ownerId)) {
      await ctx.answerCbQuery("❌ 𝗛𝗮𝗻𝘆𝗮 𝗢𝘄𝗻𝗲𝗿 𝗦𝗮𝗷𝗮 𝗬𝗮𝗻𝗴 𝗕𝗶𝘀𝗮 𝗠𝗲𝗺𝗯𝗮𝗹𝗮𝘀 𝗣𝗲𝘀𝗮𝗻 𝗨𝘀𝗲𝗿.", { show_alert: true });
      return;
    }
    const targetId = ctx.match[1];
    ownerReplyState[ctx.from.id] = { target: targetId, step: "WAITING_REPLY" };
    await ctx.answerCbQuery();
    await safeReply(ctx, "✉️ <b>𝗦𝗶𝗹𝗮𝗵𝗸𝗮𝗻 𝗞𝗶𝗿𝗶𝗺 𝗕𝗮𝗹𝗮𝘀𝗮𝗻 𝗔𝗻𝗱𝗮 𝗦𝗲𝗸𝗮𝗿𝗮𝗻𝗴!</b>\n━━━━━━━━━━━━━━━━━━━━❍\n<b>🌸 𝗝𝗲𝗻𝗶𝘀 𝗕𝗮𝗹𝗮𝘀𝗮𝗻 𝗕𝗶𝘀𝗮 𝗕𝗲𝗿𝘂𝗽𝗮 :</b>\n<b>➥ 𝗧𝗲𝗸𝘀 | 𝗙𝗼𝘁𝗼 | 𝗩𝗶𝗱𝗲𝗼 | 𝗙𝗶𝗹𝗲</b>\n<b>➥ 𝗞𝗲𝘁𝗶𝗸 /batal 𝗨𝗻𝘁𝘂𝗸 𝗠𝗲𝗺𝗯𝗮𝘁𝗮𝗹𝗸𝗮𝗻.</b>", { parse_mode: "HTML" });
  } catch (e) {}
});

async function forwardReplyToUser(ownerCtx, targetUserId, messageType, payload) {
  try {
    if (messageType === "text") {
      await bot.telegram.sendMessage(targetUserId, `💬 <b>𝗕𝗮𝗹𝗮𝘀𝗮𝗻 𝗗𝗮𝗿𝗶 𝗢𝘄𝗻𝗲𝗿:</b>\n\n${payload}`, { parse_mode: "HTML" });
      await ownerCtx.reply("✅ 𝗕𝗮𝗹𝗮𝘀𝗮𝗻 𝗕𝗲𝗿𝗵𝗮𝘀𝗶𝗹 𝗧𝗲𝗿𝗸𝗶𝗿𝗶𝗺 𝗦𝗲𝗯𝗮𝗴𝗮𝗶 𝗧𝗲𝗸𝘀.");
      return;
    }
  } catch (e) {
    await ownerCtx.reply("❌ 𝗚𝗮𝗴𝗮𝗹 𝗠𝗲𝗻𝗴𝗶𝗿𝗶𝗺 𝗕𝗮𝗹𝗮𝘀𝗮𝗻 𝗞𝗲 𝗨𝘀𝗲𝗿.");
  }
}

bot.on("text", async (ctx, next) => {
  try {
    const st = ownerReplyState[ctx.from.id];
    if (st && st.step === "WAITING_REPLY") {
      const target = st.target;
      const text = ctx.message.text;
      delete ownerReplyState[ctx.from.id];
      await forwardReplyToUser(ctx, target, "text", text);
      return;
    }
  } catch (e) {}
  return next();
});

function getFileExtension(name) {
    const ext = name.split(".").pop().toLowerCase();
    if (["js"].includes(ext)) return "javascript";
    if (["py"].includes(ext)) return "python";
    if (["html","htm"].includes(ext)) return "html";
    if (["css"].includes(ext)) return "css";
    if (["json"].includes(ext)) return "json";
    if (["zip","rar","7z","tar","gz"].includes(ext)) return "archive";
    return "text";
}

async function downloadFile(fileId) {
    try {
        const fileLink = await bot.telegram.getFileLink(fileId);
        const res = await axios.get(fileLink, { responseType: "arraybuffer" });
        return res.data;
    } catch (err) {
        throw new Error("Gagal download file: " + err.message);
    }
}

function getFileContent(buffer) {
    try {
        return Buffer.from(buffer).toString("utf8");
    } catch (err) {
        throw new Error("Gagal membaca file: " + err.message);
    }
}

async function analyzeErrorWithGemini(codeContent, fileName) {
    try {
        if (getFileExtension(fileName) === "archive") {
            return "❌ <b>File adalah arsip (zip/rar), bukan file kode.</b>\nSilakan ekstrak dulu dan kirim file kode individual (js, py, html, css, json).";
        }
        
        const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${config.GEMINI_API_KEY}`,
            {
                contents: [{
                    parts: [{
                        text: `Deteksi error pada file bernama ${fileName}. Berikan hasilnya dalam format:

\`\`\`${getFileExtension(fileName)}
(kode atau analisis singkat di sini)
\`\`\`

JANGAN beri penjelasan panjang. Singkat & jelas saja.

Isi file:
${codeContent}
`
                    }]
                }]
            }
        );
        return res.data.candidates[0].content.parts[0].text;
    } catch (err) {
        throw new Error("Gemini error: " + err.message);
    }
}

async function fixErrorWithGemini(codeContent, fileName) {
    try {
        if (getFileExtension(fileName) === "archive") {
            throw new Error("File adalah arsip (zip/rar), bukan file kode. Silakan ekstrak dulu.");
        }
        
        const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${config.GEMINI_API_KEY}`,
            {
                contents: [{
                    parts: [{
                        text: `Perbaiki error dalam file ${fileName} dan kirimkan hanya kode final:\n\n${codeContent}`
                    }]
                }]
            }
        );
        return res.data.candidates[0].content.parts[0].text;
    } catch (err) {
        throw new Error("Gemini error: " + err.message);
    }
}

const premiumUsers = new Set([config.ownerId]);
let userLimits = new Map();

function updateUserLimit(userId) {
    if (premiumUsers.has(userId)) return 999;
    const now = userLimits.get(userId) || config.USER_LIMIT;
    const sisa = now - 1;
    userLimits.set(userId, sisa);
    return sisa;
}

function getUserLimit(userId) {
    return premiumUsers.has(userId) ? "Unlimited" : (userLimits.get(userId) || config.USER_LIMIT);
}

function loadUsers() {
  if (!fs.existsSync(USERS_DB)) {
    fs.writeFileSync(USERS_DB, JSON.stringify([]));
  }
  return JSON.parse(fs.readFileSync(USERS_DB));
}

function saveUsers(list) {
  fs.writeFileSync(USERS_DB, JSON.stringify(list, null, 2));
}

function checkAndAddUser(user) {
  const users = loadUsers()
  const isNewUser = !users.includes(user.id)
  
  if (isNewUser) {
    users.push(user.id)
    saveUsers(users)
    
    notifyOwnerNewUser(user)
    
    return true
  }
  return false
}

bot.on("message", (ctx, next) => {
  try {
    checkAndAddUser(ctx.from);
  } catch (e) {
    console.error("[ERROR] Error adding user:", e);
  }
  return next();
});

function readDb() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({
      isPanelOpen: true,
      scripts: [],
      apps: [],
      paymentMethod: config.payment?.method || 'orkut'
    }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH));
}

function saveDb(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function getActivePaymentMethod() {
  const db = readDb();
  return (db && db.paymentMethod) ? db.paymentMethod : (config.payment?.method || 'orkut');
}
function setActivePaymentMethod(method) {
  const db = readDb();
  db.paymentMethod = method;
  saveDb(db);
}

async function createAdminAccount(username) {
  try {
    const headers = {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.panel.apikey}`
    };
    
    const password = username + "001";
    const email = `${username.toLowerCase()}@admin.com`;

    const userRes = await axios.post(`${config.panel.domain}/api/application/users`, {
      email: email,
      username: username.toLowerCase(),
      first_name: username,
      last_name: "Admin",
      language: "en",
      password: password,
      root_admin: true
    }, { headers });

    const user = userRes.data.attributes;

    return { 
        success: true, 
        data: { 
            id: user.id,
            username: user.username, 
            password: password, 
            email: user.email,
            login: config.panel.domain 
        } 
    };
  } catch (error) {
    console.error("Create Admin Error:", error.response?.data || error.message);
    return { success: false, msg: error.response?.data?.errors?.[0]?.detail || error.message };
  }
}
async function createPanelAccount(username, ram, disk, cpu) {
  try {
    const headers = {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.panel.apikey}`
    };
    const password = username + "001";
    const email = `${username.toLowerCase()}@gmail.com`;

    const userRes = await axios.post(`${config.panel.domain}/api/application/users`, {
      email, username: username.toLowerCase(), first_name: username, last_name: "User", language: "en", password
    }, { headers });

    const user = userRes.data.attributes;

    await axios.post(`${config.panel.domain}/api/application/servers`, {
      name: `${username} Server`,
      user: user.id,
      egg: config.panel.eggId,
      docker_image: config.panel.image,
      startup: config.panel.startup,
      environment: { INST: "npm", USER_UPLOAD: "0", AUTO_UPDATE: "0", CMD_RUN: "npm start" },
      limits: { memory: ram, swap: 0, disk: disk, io: 500, cpu: cpu },
      feature_limits: { databases: 1, backups: 1, allocations: 1 },
      deploy: { locations: [config.panel.locationId], dedicated_ip: false, port_range: [] }
    }, { headers });

    return { success: true, data: { username: user.username, password, login: config.panel.domain } };
  } catch (error) {
    return { success: false, msg: error.response?.data?.errors?.[0]?.detail || error.message };
  }
}

bot.start(async (ctx) => {
  const stats = getBotStats()
  
  checkAndAddUser(ctx.from)
  
  const welcomeText = `<blockquote>𝗪𝗘𝗟𝗖𝗢𝗠𝗘</blockquote>
<blockquote> <b>𝗜𝗡𝗙𝗢𝗥𝗠𝗔𝗦𝗜 𝗕𝗢𝗧</b>
➥ OwnerBot : ${stats.ownerName}
➥ 𝖡𝗈𝗍 𝖭𝖺𝗆𝖾 : ${stats.botName}
➥ 𝖵𝖾𝗋𝗌𝗂𝗈𝗇 : 1.0.0
➥ 𝖳𝗈𝗍𝖺𝗅 𝖴𝗌𝖾𝗋 : ${stats.totalUsers}
➥ 𝖱𝗎𝗇𝗍𝗂𝗆𝖾 : ${stats.runtime}</blockquote>
<blockquote><b>[ 𐚁 ] 𝖯𝗅𝖾𝖺𝗌𝖾 𝖯𝗋𝖾𝗌𝗌 𝖳𝗁𝖾 𝖡𝗎𝗍𝗍𝗈𝗇
𝖡𝖾𝗅𝗈𝗐 𝖠𝖼𝖼𝗈𝗋𝖽𝗂𝗇𝗀 𝖳𝗈 𝖸𝗈𝗎𝗋 𝖭𝖾𝖾𝖽𝗌!</b></blockquote>`

  const menuKeyboard = {
    inline_keyboard: [
      [
        { text: `⛥ ☇ ya`, callback_data: `shop_menu` },
        { text: `⛥ ☇ 𝗠𝗲𝗻𝘂 𝗧𝗼𝗼𝗹𝘀`, callback_data: `menu_tools` }
      ],
      [
        { text: `⛥ ☇ 𝗢𝘄𝗻𝗲𝗿 𝗕𝗼𝘁`, callback_data: `menu_owner_contact` }
      ], 
      [
        { text: `⛥ ☇ 𝗖𝗵𝗮𝗻𝗻𝗲𝗹 𝗜𝗻𝗳𝗼`, url: `https://t.me/${config.channelName}` }, 
        { text: `⛥ ☇ 𝗥𝗼𝗼𝗺 𝗣𝘂𝗯𝗹𝗶𝗰`, url: `https://t.me/${config.grubName}` }
      ]
    ]
  }

  if (config.startPhoto) {
    try {
      await ctx.replyWithPhoto(config.startPhoto, {
        caption: welcomeText,
        parse_mode: "HTML",
        reply_markup: menuKeyboard
      })
    } catch (e) {
      await safeReply(ctx, welcomeText, {
        parse_mode: "HTML",
        reply_markup: menuKeyboard
      })
    }
  } else {
    await safeReply(ctx, welcomeText, {
      parse_mode: "HTML",
      reply_markup: menuKeyboard
    })
  }

  if (config.startAudio && config.startAudio.trim() !== "") {
    try {
      await ctx.replyWithAudio(config.startAudio, {
        caption: config.startAudioCaption || "",
        parse_mode: "HTML"
      })
    } catch (audioError) {
    }
  }

  if (ctx.from.id === config.ownerId) {
    await safeReply(ctx, `<blockquote><b>🌸 𝗪𝗲𝗹𝗰𝗼𝗺𝗲 𝗠𝘆 𝗢𝘄𝗻𝗲𝗿!</b></blockquote>`, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "𝗠𝗲𝗻𝘂 𝗢𝘄𝗻𝗲𝗿", callback_data: "menu_owner" }]]
      }
    })
  }
})

bot.action("menu_scripts", async (ctx) => {
  if (!await requirePrivateChat(ctx, 'menu_scripts')) return;
  
  const db = readDb();
  if ((db.scripts || []).length === 0) {
    await editMenuMessage(ctx, "🚫 <b>𝗠𝗼𝗵𝗼𝗻 𝗠𝗮𝗮𝗳, 𝗕𝗲𝗹𝘂𝗺 𝗔𝗱𝗮 𝗦𝗰𝗿𝗶𝗽𝘁 𝗕𝗼𝘁 𝗬𝗮𝗻𝗴 𝗗𝗶𝗷𝘂𝗮𝗹 𝗢𝗹𝗲𝗵 𝗢𝘄𝗻𝗲𝗿 𝗕𝗼𝘁.</b>", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", callback_data: "back_home" }]
        ]
      }
    });
    return;
  }
  
  const buttons = db.scripts.map((item, index) => {
    return [{ text: `${item.nama} - ${toRupiah(item.harga)}`, callback_data: `buy_sc_${index}` }];
  });
  
  buttons.push([{ text: "🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", callback_data: "back_home" }]);
  
  await editMenuMessage(ctx, "<b>📂 𝗣𝗶𝗹𝗶𝗵 𝗦𝗰𝗿𝗶𝗽𝘁 𝗗𝗶𝗯𝗮𝘄𝗮𝗵 𝗬𝗮𝗻𝗴 𝗜𝗻𝗴𝗶𝗻 𝗞𝗮𝗺𝘂 𝗕𝗲𝗹𝗶 :</b>", {
    reply_markup: { inline_keyboard: buttons }
  });
});

bot.action("menu_apps", async (ctx) => {
  if (!await requirePrivateChat(ctx, 'menu_apps')) return;
  
  const db = readDb();
  if ((db.apps || []).length === 0) {
    await editMenuMessage(ctx, "🚫 <b>𝗠𝗼𝗵𝗼𝗻 𝗠𝗮𝗮𝗳, 𝗕𝗲𝗹𝘂𝗺 𝗔𝗱𝗮 𝗔𝗽𝗽𝘀 𝗣𝗿𝗲𝗺𝗶𝘂𝗺 𝗬𝗮𝗻𝗴 𝗗𝗶𝗷𝘂𝗮𝗹 𝗢𝗹𝗲𝗵 𝗢𝘄𝗻𝗲𝗿 𝗕𝗼𝘁.</b>", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", callback_data: "back_home" }]
        ]
      }
    });
    return;
  }
  
  const buttons = db.apps.map((app, i) => {
    const stock = (app.accounts || []).length;
    return [{ text: `${app.nama} (${stock} stok) - ${toRupiah(app.harga)}`, callback_data: `buy_app_${i}` }];
  });
  
  buttons.push([{ text: "🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", callback_data: "back_home" }]);
  
  await editMenuMessage(ctx, "<b>📱 𝗗𝗮𝗳𝘁𝗮𝗿 𝗔𝗽𝗽𝘀 𝗣𝗿𝗲𝗺𝗶𝘂𝗺 :</b>", {
    reply_markup: { inline_keyboard: buttons }
  });
});

bot.action("menu_panel", async (ctx) => {
  if (!await requirePrivateChat(ctx, 'menu_panel')) return;
  
  const db = readDb();
  if (!db.isPanelOpen) {
    await editMenuMessage(ctx, "<b>🚫 𝗠𝗼𝗵𝗼𝗻 𝗠𝗮𝗮𝗳, 𝗦𝘁𝗼𝗸 𝗣𝗮𝗻𝗲𝗹 𝗕𝗲𝗹𝘂𝗺 𝗧𝗲𝗿𝘀𝗲𝗱𝗶𝗮 𝗨𝗻𝘁𝘂𝗸 𝗦𝗮𝗮𝘁 𝗜𝗻𝗶. 𝗦𝗶𝗹𝗮𝗵𝗸𝗮𝗻 𝗖𝗼𝗯𝗮 𝗟𝗮𝗴𝗶 𝗡𝗮𝗻𝘁𝗶</b>.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", callback_data: "back_home" }]
        ]
      }
    });
    return;
  }

  userState[ctx.from.id] = { step: "WAITING_USERNAME_PANEL" };

  await editMenuMessage(ctx,
    "<b>🍂 𝗦𝗶𝗹𝗮𝗵𝗸𝗮𝗻 𝗞𝗶𝗿𝗶𝗺 𝗨𝘀𝗲𝗿𝗻𝗮𝗺𝗲 𝗨𝗻𝘁𝘂𝗸 𝗣𝗮𝗻𝗲𝗹 𝗬𝗮𝗻𝗴 𝗜𝗻𝗴𝗶𝗻 𝗞𝗮𝗺𝘂 𝗕𝗲𝗹𝗶 𝗗𝗲𝗻𝗴𝗮𝗻 𝗠𝗶𝗻𝗶𝗺𝗮𝗹 𝟱-𝟴 𝗛𝘂𝗿𝘂𝗳.</b>\n",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "❌ 𝗕𝗮𝘁𝗮𝗹 𝗠𝗲𝗺𝗯𝗲𝗹𝗶 𝗣𝗮𝗻𝗲𝗹", callback_data: "back_home" }]
        ]
      }
    }
  );

  setTimeout(() => {
    const st = userState[ctx.from.id];
    if (st && st.step === "WAITING_USERNAME_PANEL") {
      delete userState[ctx.from.id];
      safeReply(ctx, "❌ <b>𝗪𝗮𝗸𝘁𝘂 𝗦𝘂𝗱𝗮𝗵 𝗛𝗮𝗯𝗶𝘀!</b>\n🚀 𝗦𝗶𝗹𝗮𝗵𝗸𝗮𝗻 𝗖𝗼𝗯𝗮 𝗕𝘂𝘆 𝗣𝗮𝗻𝗲𝗹 𝗟𝗮𝗴𝗶.", { parse_mode: "HTML" });
    }
  }, 60000);
});

bot.action("shop_menu", async (ctx) => {
  if (!await requirePrivateChat(ctx, 'shop_menu')) return;
  
  await editMenuMessage(ctx, 
    `<blockquote><b>🛍️ 𝗗𝗔𝗙𝗧𝗔𝗥 𝗠𝗘𝗡𝗨 𝗟𝗔𝗬𝗔𝗡𝗔𝗡 𝗕𝗢𝗧</b>
━━━━━━━━━━━━━━━━━━━━━━━━━⨳
🍂 𝗦𝗶𝗹𝗮𝗵𝗸𝗮𝗻 𝗣𝗶𝗹𝗶𝗵 𝗣𝗿𝗼𝗱𝘂𝗸 𝗬𝗮𝗻𝗴 𝗜𝗻𝗴𝗶𝗻 𝗔𝗻𝗱𝗮 𝗢𝗿𝗱𝗲𝗿:</blockquote>`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "⛥ ☇ 𝗢𝗿𝗱𝗲𝗿 𝗡𝗼𝗸𝗼𝘀", callback_data: "choose_service" },
            { text: "⛥ ☇ 𝗢𝗿𝗱𝗲𝗿 𝗦𝘂𝗻𝘁𝗶𝗸 𝗦𝗼𝘀𝗺𝗲𝗱", callback_data: "smm_menu" }
          ],
          [
            { text: "⛥ ☇ 𝗕𝘂𝘆 𝗦𝗰𝗿𝗶𝗽𝘁", callback_data: "menu_scripts" },
            { text: "⛥ ☇ 𝗕𝘂𝘆 𝗔𝗽𝗽𝘀 𝗣𝗿𝗲𝗺𝗶𝘂𝗺", callback_data: "menu_apps" }
          ],
          [
            { text: "⛥ ☇ 𝗕𝘂𝘆 𝗣𝗮𝗻𝗲𝗹", callback_data: "menu_panel" },
            { text: "⛥ ☇ 𝗕𝘂𝘆 𝗩𝗽𝘀 𝙇𝙞𝙣𝙤𝙙𝙚", callback_data: "buyvps_start" }
          ],
          [
            { text: "⛥ ☇ 𝗕𝘂𝘆 𝗔𝗱𝗺𝗶𝗻 𝗣𝗮𝗻𝗲𝗹", callback_data: "buy_admin_panel" },
            { text: "⛥ ☇ 𝗕𝘂𝘆 𝗥𝗲𝘀𝗲𝗹𝗹𝗲𝗿 𝗣𝗮𝗻𝗲𝗹", callback_data: "buy_reseller_panel" }
          ],
          [
            { text: "🔙 ☇ 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", callback_data: "back_home" }
          ]
        ]
      }
    }
  );
});

bot.action("menu_tools", async (ctx) => {
  await editMenuMessage(ctx, 
    `<blockquote><b>╭━━━✧「 𝗧𝗢𝗢𝗟𝗦 𝗠𝗘𝗡𝗨 」✧━━━❍</b>
<b>┃ 🎬 𝗬𝗼𝘂𝘁𝘂𝗯𝗲 𝗠𝗲𝗻𝘂</b>
<b>┃ ├⌑</b> /ytsearch <i>(Searching YouTube)</i>
<b>┃ └⌑</b> /ytmp3 <i>(Audio)</i>
<b>┃</b>
<b>┃ 🎥 𝗧𝗶𝗸𝗧𝗼𝗸 𝗠𝗲𝗻𝘂</b>
<b>┃ └⌑</b> /tiktokmp4 <i>(Video)</i>
<b>┃</b>
<b>┃ 📝 𝗛𝗲𝗹𝗽 𝗠𝗲𝗻𝘂</b>
<b>┃ ├⌑</b> /checkerror
<b>┃ └⌑</b> /fixerror
<b>┃</b>
<b>┃ 🛠️ 𝗧𝗼𝗼𝗹𝘀 𝗠𝗲𝗻𝘂</b>
<b>┃ ├⌑</b> /makeqr
<b>┃ ├⌑</b> /ssweb
<b>┃ ├⌑</b> /shorten
<b>┃ ├⌑</b> /react <i>(React WA Channel)</i>
<b>┃ ├⌑</b> /qc <i>(Quote Creator)</i>
<b>┃ ├⌑</b> /brat <i>(Brat Sticker)</i>
<b>┃ └⌑</b> /tourl <i>(Upload to URL)</i>
<b>╰━━━━━━━━━━━━━━━━━━━━━━❍</b></blockquote>`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", callback_data: "back_home" }]
        ]
      }
    }
  );
});

bot.action("menu_owner_contact", async (ctx) => {
  await editMenuMessage(ctx,
    `<blockquote><b>📞「 𝗖𝗢𝗡𝗧𝗔𝗖𝗧 𝗢𝗪𝗡𝗘𝗥 𝗕𝗢𝗧 」</b></blockquote>\n` +
    `<b>━━━━━━━━━━━━━━━━━━━━━━❍</b>\n` +
    `<b>🍂 𝗡𝗮𝗺𝗲 :</b> ${config.ownerName || "𝗔𝗱𝗺𝗶𝗻"}\n` +
    `<b>📲 𝗪𝗵𝗮𝘁𝘀𝗮𝗽𝗽 :</b> ${config.ownerWa}\n` +
    `<b>✈️ 𝗧𝗲𝗹𝗲𝗴𝗿𝗮𝗺 :</b> ${config.ownerUser}\n` +
    `<b>━━━━━━━━━━━━━━━━━━━━━━❍</b>\n` +
    `📩 𝗞𝗮𝗺𝘂 𝗟𝗶𝗺𝗶𝘁? 𝗦𝗶𝗹𝗮𝗵𝗸𝗮𝗻 𝗞𝗹𝗶𝗸 𝗖𝗼𝗺𝗺𝗮𝗻𝗱 𝗗𝗶𝗯𝗮𝘄𝗮𝗵 :\n`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "💬 𝗞𝗶𝗿𝗶𝗺 𝗣𝗲𝘀𝗮𝗻 𝗞𝗲 𝗢𝘄𝗻𝗲𝗿", callback_data: "send_message_owner" }],
          [{ text: "🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", callback_data: "back_home" }]
        ]
      }
    }
  );
});

bot.action("send_message_owner", async (ctx) => {
  liveChatState[ctx.from.id] = { step: "WAITING_MESSAGE" };
  await editMenuMessage(ctx, 
    "📝 <b>𝗦𝗶𝗹𝗮𝗵𝗸𝗮𝗻 𝗞𝗲𝘁𝗶𝗸 𝗣𝗲𝘀𝗮𝗻 𝗨𝗻𝘁𝘂𝗸 𝗗𝗶𝗸𝗶𝗿𝗶𝗺 𝗞𝗲𝗽𝗮𝗱𝗮 𝗢𝘄𝗻𝗲𝗿 𝗕𝗼𝘁.</b>\n<b>🍂 𝗧𝗲𝗸𝗮𝗻 𝗕𝘂𝘁𝘁𝗼𝗻 𝗕𝗮𝘁𝗮𝗹 𝗗𝗶𝗯𝗮𝘄𝗮𝗵 𝗨𝗻𝘁𝘂𝗸 𝗠𝗲𝗺𝗯𝗮𝘁𝗮𝗹𝗸𝗮𝗻.</b>",
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "❌ 𝗕𝗮𝘁𝗮𝗹 𝗠𝗲𝗻𝗴𝗶𝗿𝗶𝗺 𝗣𝗲𝘀𝗮𝗻", callback_data: "back_home" }]
        ]
      }
    }
  );
});

bot.action("back_home", async (ctx) => {
  const stats = getBotStats();
  
  const welcomeText = `<blockquote>𝗪𝗘𝗟𝗖𝗢𝗠𝗘</blockquote>
<blockquote> <b>𝗜𝗡𝗙𝗢𝗥𝗠𝗔𝗦𝗜 𝗕𝗢𝗧</b>
➥ OwnerBot : ${stats.ownerName}
➥ 𝖡𝗈𝗍 𝖭𝖺𝗆𝖾 : ${stats.botName}
➥ 𝖵𝖾𝗋𝗌𝗂𝗈𝗇 : 1.0.0
➥ 𝖳𝗈𝗍𝖺𝗅 𝖴𝗌𝖾𝗋 : ${stats.totalUsers}
➥ 𝖱𝗎𝗇𝗍𝗂𝗆𝖾 : ${stats.runtime}</blockquote>
<blockquote><b>[ 𐚁 ] 𝖯𝗅𝖾𝖺𝗌𝖾 𝖯𝗋𝖾𝗌𝗌 𝖳𝗁𝖾 𝖡𝗎𝗍𝗍𝗈𝗇
𝖡𝖾𝗅𝗈𝗐 𝖠𝖼𝖼𝗈𝗋𝖽𝗂𝗇𝗀 𝖳𝗈 𝖸𝗈𝗎𝗋 𝖭𝖾𝖾𝖽𝗌!</b></blockquote>`;

  const menuKeyboard = {
    inline_keyboard: [
      [
        { text: `⛥ ☇ ya`, callback_data: `shop_menu` },
        { text: `⛥ ☇ 𝗠𝗲𝗻𝘂 𝗧𝗼𝗼𝗹𝘀`, callback_data: `menu_tools` }
      ],
      [
        { text: `⛥ ☇ 𝗢𝘄𝗻𝗲𝗿 𝗕𝗼𝘁`, callback_data: `menu_owner_contact` }
      ], 
      [
        { text: `⛥ ☇ 𝗖𝗵𝗮𝗻𝗻𝗲𝗹 𝗜𝗻𝗳𝗼`, url: `https://t.me/${config.channelName}` }, 
        { text: `⛥ ☇ 𝗥𝗼𝗼𝗺 𝗣𝘂𝗯𝗹𝗶𝗰`, url: `https://t.me/${config.grubName}` }
      ]
    ]
  };

  if (config.startPhoto) {
    try {
      await editMenuMessageWithPhoto(ctx, config.startPhoto, welcomeText, {
        parse_mode: "HTML",
        reply_markup: menuKeyboard
      });
    } catch (e) {
      try {
        await editMenuMessage(ctx, welcomeText, {
          parse_mode: "HTML",
          reply_markup: menuKeyboard
        });
      } catch (err) {
        await safeReply(ctx, welcomeText, {
          parse_mode: "HTML",
          reply_markup: menuKeyboard
        });
      }
    }
  } else {
    try {
      await editMenuMessage(ctx, welcomeText, {
        parse_mode: "HTML",
        reply_markup: menuKeyboard
      });
    } catch (err) {
      await safeReply(ctx, welcomeText, {
        parse_mode: "HTML",
        reply_markup: menuKeyboard
      });
    }
  }
});

function showOwnerMenu(ctx) {
  if (String(ctx.from.id) !== String(config.ownerId)) 
    return safeReply(ctx, "<blockquote>🚫 <b>Kamu Bukan Owner Bot!</b></blockquote>", { parse_mode: "HTML" });

  safeReply(ctx, `<blockquote><b>🌸───「 ❝ 𝗢𝗪𝗡𝗘𝗥 𝗠𝗘𝗡𝗨 ❞ 」───🌸</b>\n<b>➥ Silahkan Tekan Button Dibawah:</b></blockquote>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [ Markup.button.callback("⛥ ☇ 𝗦𝗲𝘁𝘁𝗶𝗻𝗴 𝗣𝗮𝗻𝗲𝗹 (𝗢𝗻/𝗢𝗳𝗳)", "owner_panel") ],
        [ Markup.button.callback("⛥ ☇ 𝗕𝗿𝗼𝗮𝗱𝗰𝗮𝘀𝘁", "owner_broadcast") ],
        [
          Markup.button.callback("⛥ ☇ 𝗔𝗱𝗱 𝗦𝗰𝗿𝗶𝗽𝘁", "add_script"),
          Markup.button.callback("⛥ ☇ 𝗗𝗲𝗹𝗲𝘁𝗲 𝗦𝗰𝗿𝗶𝗽𝘁", "del_script")
        ],
        [
          Markup.button.callback("⛥ ☇ 𝗔𝗱𝗱 𝗔𝗽𝗽 𝗣𝗿𝗲𝗺𝗶𝘂𝗺", "add_app"),
          Markup.button.callback("⛥ ☇ 𝗗𝗲𝗹𝗲𝘁𝗲 𝗔𝗽𝗽", "del_app")
        ],
        [
          Markup.button.callback("⛥ ☇ 𝗔𝗱𝗱 𝗔𝗰𝗰𝗼𝘂𝗻𝘁", "owner_add_account"),
          Markup.button.callback("⛥ ☇ 𝗗𝗲𝗹𝗲𝘁𝗲 𝗔𝗰𝗰𝗼𝘂𝗻𝘁", "owner_del_account")
        ],
        [ Markup.button.callback("⛥ ☇ 𝗟𝗶𝘀𝘁 𝗩𝗣𝗦 𝗢𝗿𝗱𝗲𝗿𝘀", "list_vps_orders") ],
        [ Markup.button.callback("⛥ ☇ 𝗟𝗶𝘀𝘁 𝗔𝗽𝗽 𝗣𝗿𝗲𝗺𝗶𝘂𝗺", "list_apps") ],
        [ Markup.button.callback("⛥ ☇ 𝗚𝗮𝗻𝘁𝗶 𝗠𝗲𝘁𝗼𝗱𝗲 𝗣𝗮𝘆𝗺𝗲𝗻𝘁", "change_payment") ],
        [ Markup.button.callback("⛥ ☇ 𝗠𝗲𝗻𝘂 𝗠𝗮𝗻𝘂𝗮𝗹 𝗣𝗮𝘆𝗺𝗲𝗻𝘁𝘀", "manual_payments_menu") ],
        [ Markup.button.callback("⛥ ☇ 𝗪𝗶𝘁𝗵𝗱𝗿𝗮𝘄 𝗦𝗮𝗹𝗱𝗼 (𝗔𝗹𝘁𝗮𝗻𝘁𝗶𝗰)", "menu_wd_info") ],
        [ Markup.button.callback("⛥ ☇ 𝗕𝗮𝗰𝗸𝘂𝗽 𝗗𝗮𝘁𝗮𝗯𝗮𝘀𝗲", "backup_database") ],
        [ Markup.button.callback("⛥ ☇ 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", "back_home") ]
      ])
    }
  );
}

bot.action("menu_owner", (ctx) => {
  ctx.answerCbQuery().catch(()=>{});
  showOwnerMenu(ctx);
});

bot.action("smm_menu", async (ctx) => {
    const userId = ctx.from.id;
    const saldoData = JSON.parse(fs.readFileSync("./database/saldoOtp.json", "utf8") || "{}");
    const saldo = saldoData[userId] || 0;

    const text = `
╔══════════════════════════╗
║     🔥 <b>𝗦𝗨𝗡𝗧𝗜𝗞 𝗦𝗢𝗦𝗠𝗘𝗗</b> 🔥     ║
╠══════════════════════════╣
║ 👤 <b>𝖴𝗌𝖾𝗋 :</b> ${ctx.from.first_name}
║ 💰 <b>𝖲𝖺𝗅𝖽𝗈 :</b> ${toRupiah(saldo)}
║
║ 🚀 <i>𝖡𝖾𝗋𝗂𝗄𝗎𝗍 𝖫𝖺𝗒𝖺𝗇𝖺𝗇 𝖲𝗎𝗇𝗍𝗂𝗄 𝖲𝗈𝗌𝗆𝖾𝖽</i>
╚══════════════════════════╝`;

    await editMenuMessage(ctx, text, {
        parse_mode: "HTML",
        reply_markup: {
            inline_keyboard: [
                [{ text: "⛥ 𝗗𝗲𝗽𝗼𝘀𝗶𝘁", callback_data: "topup_nokos" }],
                [{ text: "⛥ 𝗗𝗮𝗳𝘁𝗮𝗿 𝗟𝗮𝘆𝗮𝗻𝗮𝗻", callback_data: "smm_services_0" }],
                [{ text: "⛥ 𝗥𝗶𝘄𝗮𝘆𝗮𝘁 𝗢𝗿𝗱𝗲𝗿", callback_data: "smm_history" }],
                [{ text: "⛥ 𝗖𝗲𝗸 𝗦𝘁𝗮𝘁𝘂𝘀 𝗢𝗿𝗱𝗲𝗿", callback_data: "smm_check_status" }],
                [{ text: "🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", callback_data: "shop_menu" }]
            ]
        }
    });
});

bot.action("list_vps_orders", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang boleh melihat order VPS!", { show_alert: true });
  }
  
  const vpsPath = "./database/data_vps.json";
  
  if (!fs.existsSync(vpsPath)) {
    return safeReply(ctx, "<blockquote>📭 Belum ada data VPS yang terjual.</blockquote>", { 
      parse_mode: "HTML" 
    });
  }
  
  try {
    const vpsDB = JSON.parse(fs.readFileSync(vpsPath));
    
    if (!Array.isArray(vpsDB) || vpsDB.length === 0) {
      return safeReply(ctx, "<blockquote>📭 Belum ada data VPS yang terjual.</blockquote>", { 
        parse_mode: "HTML" 
      });
    }
    
    let message = "<b>📋 DAFTAR ORDER VPS</b>\n\n";
    
    vpsDB.forEach((vps, i) => {
      message += `<b>${i + 1}. ${vps.hostname}</b>\n`;
      message += `<code>   User:</code> ${vps.username} (${vps.userId})\n`;
      message += `<code>   IP:</code> ${vps.ip}\n`;
      message += `<code>   Region:</code> ${vps.region}\n`;
      message += `<code>   Paket:</code> ${vps.paket}\n`;
      message += `<code>   Harga:</code> ${toRupiah(vps.harga)}\n`;
      message += `<code>   Tanggal:</code> ${vps.created}\n\n`;
    });
    
    await safeReply(ctx, message, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", "menu_owner")]
      ])
    });
    
  } catch (error) {
    console.error("Error reading VPS data:", error);
    safeReply(ctx, "<blockquote>❌ Gagal membaca data VPS.</blockquote>", { 
      parse_mode: "HTML" 
    });
  }
});

bot.action("backup_database", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang boleh backup!", { show_alert: true });
  }
  
  await ctx.answerCbQuery("⏳ Memproses Full Backup...", { show_alert: false });
  await safeReply(ctx, "<blockquote>📦 <b>Sedang mempacking seluruh Source Code & Database...</b>\n<i>Mohon tunggu, proses tergantung ukuran file.</i></blockquote>", { parse_mode: "HTML" });
  
  createAndSendFullBackup(ctx, false);
});


bot.action("manual_payments_menu", (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  ctx.answerCbQuery().catch(()=>{});
  
  const payments = readManualPayments();
  const pendingCount = payments.filter(p => p.status === "pending").length;
  
  safeReply(ctx, `<blockquote><b>🧾 𝗠𝗲𝗻𝘂 𝗣𝗮𝘆𝗺𝗲𝗻𝘁 𝗠𝗮𝗻𝘂𝗮𝗹</b>\n<b>𝖯𝖾𝗇𝖽𝗂𝗇𝗀:</b> ${pendingCount}</blockquote>`, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [ Markup.button.callback("📋 𝗟𝗶𝘀𝘁 𝗣𝗲𝗻𝗱𝗶𝗻𝗴", "list_pending_payments") ],
      [ Markup.button.callback("📜 𝗔𝗹𝗹 𝗣𝗮𝘆𝗺𝗲𝗻𝘁", "list_all_payments") ],
      [ Markup.button.callback("🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", "menu_owner") ]
    ])
  });
});

bot.action("list_pending_payments", (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("🚫 𝗞𝗮𝗺𝘂 𝗕𝘂𝗸𝗮𝗻𝗹𝗮𝗵 𝗢𝘄𝗻𝗲𝗿 𝗕𝗼𝘁!");
  
  const payments = readManualPayments();
  const pending = payments.filter(p => p.status === "pending");
  
  if (pending.length === 0) {
    safeReply(ctx, "⏳ 𝗧𝗶𝗱𝗮𝗸 𝗔𝗱𝗮 𝗣𝗲𝗺𝗯𝗮𝘆𝗮𝗿𝗮𝗻 𝗬𝗮𝗻𝗴 𝗦𝗲𝗱𝗮𝗻𝗴 𝗣𝗲𝗻𝗱𝗶𝗻𝗴");
    return showOwnerMenu(ctx);
  }
  
  let message = "<b>📋 𝗗𝗮𝘁𝗮 𝗣𝗲𝗺𝗯𝗮𝘆𝗮𝗿𝗮𝗻 𝗣𝗲𝗻𝗱𝗶𝗻𝗴</b>\n\n";
  pending.forEach((p, i) => {
    message += `<b>${i+1}. ${p.userName} (${p.userId})</b>\n`;
    message += `<code>   𝗜𝘁𝗲𝗺 :</code> ${p.itemName}\n`;
    message += `<code>   𝗔𝗺𝗼𝘂𝗻𝘁 :</code> ${toRupiah(p.amount)}\n`;
    message += `<code>   𝗧𝗶𝗺𝗲 :</code> ${new Date(p.timestamp).toLocaleString()}\n`;
    message += `   [Verify](tg://user?id=${p.userId})\n\n`;
  });
  
  safeReply(ctx, message, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [ Markup.button.callback("🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", "manual_payments_menu") ]
    ])
  });
});

bot.action("list_all_payments", (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  
  const payments = readManualPayments();
  
  if (payments.length === 0) {
    safeReply(ctx, "❌ 𝗕𝗲𝗹𝘂𝗺 𝗔𝗱𝗮 𝗥𝗶𝘄𝗮𝘆𝗮𝘁 𝗣𝗲𝗺𝗯𝗮𝘆𝗮𝗿𝗮𝗻 𝗠𝗮𝗻𝘂𝗮𝗹.");
    return showOwnerMenu(ctx);
  }
  
  let message = "<b>📜 𝗕𝗲𝗿𝗶𝗸𝘂𝘁 𝗥𝗶𝘄𝗮𝘆𝗮𝘁 𝗣𝗲𝗺𝗯𝗮𝘆𝗮𝗿𝗮𝗻 𝗠𝗮𝗻𝘂𝗮𝗹l</b>\n\n";
  payments.forEach((p, i) => {
    const statusEmoji = p.status === "𝗔𝗽𝗽𝗿𝗼𝘃𝗲𝗱" ? "✅" : p.status === "𝗥𝗲𝗷𝗲𝗰𝘁𝗲𝗱" ? "❌" : "⏳";
    message += `<b>${i+1}. ${statusEmoji} ${p.userName}</b>\n`;
    message += `<code>   𝗜𝘁𝗲𝗺 :</code> ${p.itemName}\n`;
    message += `<code>   𝗔𝗺𝗼𝘂𝗻𝘁 :</code> ${toRupiah(p.amount)}\n`;
    message += `<code>   𝗦𝘁𝗮𝘁𝘂𝘀 :</code> ${p.status}\n`;
    message += `<code>   𝗧𝗶𝗺𝗲 :</code> ${new Date(p.timestamp).toLocaleString()}\n\n`;
  });
  
  safeReply(ctx, message, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [ Markup.button.callback("🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", "manual_payments_menu") ]
    ])
  });
});

bot.action("change_payment", (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  ctx.answerCbQuery().catch(()=>{});
  const active = getActivePaymentMethod();
  safeReply(ctx, `<b>💸 𝗠𝗲𝘁𝗼𝗱𝗲 𝗣𝗲𝗺𝗯𝗮𝘆𝗮𝗿𝗮𝗻 𝗬𝗮𝗻𝗴 𝗔𝗸𝘁𝗶𝗳 𝗦𝗮𝗮𝘁 𝗜𝗻𝗶 :</b> <code>${active.toUpperCase()}</code>\n<b>🚀 𝗦𝗶𝗹𝗮𝗵𝗸𝗮𝗻 𝗣𝗶𝗹𝗶𝗵 𝗣𝗮𝘆𝗺𝗲𝗻𝘁 𝗕𝗮𝗿𝘂 𝗗𝗶𝗯𝗮𝘄𝗮𝗵:</b>`, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [ Markup.button.callback("⛥ 𝗔𝘁𝗹𝗮𝗻𝘁𝗶𝗰", "set_payment_atlantic") ],
      [ Markup.button.callback("⛥ 𝗢𝗿𝗸𝘂𝘁 / 𝗢𝗿𝗱𝗲𝗿𝗞𝘂𝗼𝘁𝗮", "set_payment_orkut") ],
      [ Markup.button.callback("⛥ 𝗠𝗮𝗻𝘂𝗮𝗹 (𝗤𝗥𝗜𝗦 𝗙𝗼𝘁𝗼)", "set_payment_manual") ],
      [ Markup.button.callback("⛥ 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", "menu_owner") ]
    ])
  });
});

bot.action("set_payment_atlantic", (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  setActivePaymentMethod("atlantic");
  safeReply(ctx, "✅ <b>𝗠𝗲𝘁𝗼𝗱𝗲 𝗣𝗲𝗺𝗯𝗮𝘆𝗮𝗿𝗮𝗻 𝗕𝗲𝗿𝗵𝗮𝘀𝗶𝗹 𝗗𝗶𝗴𝗮𝗻𝘁𝗶 𝗞𝗲 𝗔𝗧𝗟𝗔𝗡𝗧𝗜𝗖</b>", { parse_mode: "HTML" });
  showOwnerMenu(ctx);
});

bot.action("set_payment_orkut", (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  setActivePaymentMethod("orkut");
  safeReply(ctx, "✅ <b>𝗠𝗲𝘁𝗼𝗱𝗲 𝗣𝗲𝗺𝗯𝗮𝘆𝗮𝗿𝗮𝗻 𝗕𝗲𝗿𝗵𝗮𝘀𝗶𝗹 𝗗𝗶𝗴𝗮𝗻𝘁𝗶 𝗞𝗲 𝗢𝗥𝗞𝗨𝗧</b>", { parse_mode: "HTML" });
  showOwnerMenu(ctx);
});

bot.action("set_payment_manual", (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  setActivePaymentMethod("manual");
  safeReply(ctx, "✅ <b>𝗠𝗲𝘁𝗼𝗱𝗲 𝗣𝗲𝗺𝗯𝗮𝘆𝗮𝗿𝗮𝗻 𝗕𝗲𝗿𝗵𝗮𝘀𝗶𝗹 𝗗𝗶𝗴𝗮𝗻𝘁𝗶 𝗞𝗲 𝗤𝗥𝗜𝗦 𝗠𝗮𝗻𝘂𝗮𝗹</b>", { parse_mode: "HTML" });
  showOwnerMenu(ctx);
});

bot.action("owner_panel", (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  const db = readDb();
  db.isPanelOpen = !db.isPanelOpen;
  saveDb(db);
  const status = db.isPanelOpen ? "🟢 𝗣𝗮𝗻𝗲𝗹 𝗢𝗻𝗹𝗶𝗻𝗲" : "🔴 𝗣𝗮𝗻𝗲𝗹 𝗢𝗳𝗳𝗹𝗶𝗻𝗲";
  safeReply(ctx, `<b>🚀 𝗦𝘁𝗮𝘁𝘂𝘀 𝗣𝗮𝗻𝗲𝗹 𝗦𝗲𝗸𝗮𝗿𝗮𝗻𝗴 :</b> ${status}`, { parse_mode: "HTML" });
});

bot.action("owner_broadcast", (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  ctx.answerCbQuery().catch(()=>{});
  userState[ctx.from.id] = { step: "WAITING_BROADCAST" };
  safeReply(ctx, "📨 <b>𝗦𝗶𝗹𝗮𝗵𝗸𝗮𝗻 𝗞𝗶𝗿𝗶𝗺 𝗧𝗲𝗸𝘀/𝗙𝗼𝘁𝗼 𝗬𝗮𝗻𝗴 𝗜𝗻𝗴𝗶𝗻 𝗞𝗮𝗺𝘂 𝗕𝗿𝗼𝗮𝗱𝗰𝗮𝘀𝘁..</b>\n🍂 𝗧𝗲𝗸𝗮𝗻 𝗕𝘂𝘁𝘁𝗼𝗻 𝗗𝗶𝗯𝗮𝘄𝗮𝗵 𝗨𝗻𝘁𝘂𝗸 𝗠𝗲𝗺𝗯𝗮𝘁𝗮𝗹𝗸𝗮𝗻.", {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("❌ 𝗕𝗮𝘁𝗮𝗹𝗸𝗮𝗻 𝗕𝗿𝗼𝗮𝗱𝗰𝗮𝘀𝘁", "cancel_broadcast")]
    ])
  });
});

bot.action("cancel_broadcast", (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  if (userState[ctx.from.id]?.step === "WAITING_BROADCAST") {
    delete userState[ctx.from.id];
    safeReply(ctx, "❌ 𝗕𝗿𝗼𝗮𝗱𝗰𝗮𝘀𝘁 𝗕𝗲𝗿𝗵𝗮𝘀𝗶𝗹 𝗗𝗶𝗯𝗮𝘁𝗮𝗹𝗸𝗮𝗻.");
    showOwnerMenu(ctx);
  }
});

bot.action("buyvps_start", async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buyvps_start')) return;
  
  await editMenuMessage(ctx,
`<blockquote><b>🛒 𝗞𝗔𝗧𝗔𝗟𝗢𝗚 𝗩𝗣𝗦</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━⨳
📦 𝗦𝗧𝗢𝗞 𝗩𝗣𝗦 𝗦𝗘𝗞𝗔𝗥𝗔𝗡𝗚 𝗧𝗘𝗥𝗦𝗘𝗗𝗜𝗔! 
⚙️ 𝗣𝗜𝗟𝗜𝗛 𝗧𝗬𝗣𝗘 𝗩𝗣𝗦 𝗬𝗔𝗡𝗚 𝗧𝗘𝗥𝗦𝗘𝗗𝗜𝗔 :

<b>🟢 𝗩𝗣𝗦 𝗟𝗢𝗪</b>
├✧ 𝖦𝖺𝗋𝖺𝗇𝗌𝗂 : 7 𝖧𝖺𝗋𝗂
├✧ 𝖱𝖾𝗉𝗅𝖺𝖼𝖾 : unlimted
└✧ 𝖧𝖺𝗋𝗀𝖺 𝖬𝗎𝗅𝖺𝗂 𝖣𝖺𝗋𝗂 : ${toRupiah(config.hargaVPS.low['2c2'])}
━━━━━━━━━━━━━━━━━━━━━━━━━⨳

<b>🟡 𝗩𝗣𝗦 𝗠𝗘𝗗𝗜𝗨𝗠</b>
├✧ 𝖦𝖺𝗋𝖺𝗇𝗌𝗂 : 10 Hari
├✧ 𝖱𝖾𝗉𝗅𝖺𝖼𝖾 : unlimted 
└✧ 𝖧𝖺𝗋𝗀𝖺 𝖬𝗎𝗅𝖺𝗂 𝖣𝖺𝗋𝗂 : ${toRupiah(config.hargaVPS.medium['2c2'])}
━━━━━━━━━━━━━━━━━━━━━━━━━⨳

<b>🔴 𝗩𝗣𝗦 𝗛𝗜𝗚𝗛</b>
├✧ 𝖦𝖺𝗋𝖺𝗇𝗌𝗂 : 15 Hari 
├✧ 𝖱𝖾𝗉𝗅𝖺𝖼𝖾 : unlimted
└✧ 𝖧𝖺𝗋𝗀𝖺 𝖬𝗎𝗅𝖺𝗂 𝖣𝖺𝗋𝗂 : ${toRupiah(config.hargaVPS.high['2c2'])}
━━━━━━━━━━━━━━━━━━━━━━━━━⨳
<b>🚀 𝗦𝗜𝗟𝗔𝗛𝗞𝗔𝗡 𝗣𝗜𝗟𝗜𝗛 𝗞𝗔𝗧𝗔𝗟𝗢𝗚 
𝗩𝗣𝗦 𝗬𝗔𝗡𝗚 𝗧𝗘𝗥𝗦𝗘𝗗𝗜𝗔 :</b></blockquote>`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "⛥ ☇ 𝗩𝗣𝗦 𝗟𝗢𝗪", callback_data: "buyvps_pkg:low" }],
          [{ text: "⛥ ☇ 𝗩𝗣𝗦 𝗠𝗘𝗗𝗜𝗨𝗠", callback_data: "buyvps_pkg:medium" }],
          [{ text: "⛥ ☇ 𝗩𝗣𝗦 𝗛𝗜𝗚𝗛", callback_data: "buyvps_pkg:high" }],
          [{ text: "⛥ ☇ 𝗞𝗘𝗠𝗕𝗔𝗟𝗜", callback_data: "shop_menu" }]
        ]
      }
    }
  );
});

bot.action(/buyvps_pkg:(low|medium|high)/, async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buyvps_pkg')) return;
  
  const paket = ctx.match[1];
  const userId = ctx.from.id;
  
  const count = await getDropletCount();
  const sisaVPS = Math.max(0, 10 - count);

  if (sisaVPS <= 0) {
    return editMenuMessage(ctx,
`<blockquote>🚫 𝗦𝗧𝗢𝗞 𝗩𝗣𝗦 𝗦𝗨𝗗𝗔𝗛 𝗛𝗔𝗕𝗜𝗦! 
━━━━━━━━━━━━━━━━━━━━⨳
📨 𝗦𝗶𝗹𝗮𝗵𝗸𝗮𝗻 𝗛𝘂𝗯𝘂𝗻𝗴𝗶 𝗢𝘄𝗻𝗲𝗿
𝗨𝗻𝘁𝘂𝗸 𝗦𝗲𝗴𝗲𝗿𝗮 𝗥𝗲𝘀𝘁𝗼𝗰𝗸 𝗩𝗣𝗦.</blockquote>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", callback_data: "buyvps_start" }]
          ]
        }
      }
    );
  }

  if (!userState[userId]) userState[userId] = {};
  userState[userId].vpsData = { paket };

  let listRam = [];
  const dataHarga = config.hargaVPS?.[paket] || {};

  listRam = [
    { id: 1, label: "2GB 2 CPU | 60GB SSD | 3TB BW", plan: "2c2" },
    { id: 2, label: "4GB 2 CPU | 80GB SSD | 4TB BW", plan: "4c2" },
    { id: 3, label: "8GB 4 CPU | 160GB SSD | 5TB BW", plan: "8c4" },
    { id: 4, label: "16GB 4 CPU | 200GB SSD | 8TB BW", plan: "16c4" },
    { id: 5, label: "16GB 8 CPU | 320GB SSD | 6TB BW", plan: "16c8" }
  ];

  listRam = listRam.map(x => ({
    ...x,
    harga: dataHarga[x.plan] || 0
  }));

  let teks = `🖥 *PILIH SPESIFIKASI VPS*\n` +
             `──────────────────────────\n\n`;

  for (const item of listRam) {
    teks += `*${item.id}.* ${item.label}\n` +
            `└➤ *Rp ${item.harga.toLocaleString("id-ID")}*\n` +
            `──────────────────────────\n`;
  }

  teks += `\n✅ *STOK TERSEDIA : ${sisaVPS} VPS*`;

  const keyboard = listRam.map(v => [
    { 
      text: `${v.id}. ${v.label.split("|")[0].trim()} - Rp ${v.harga.toLocaleString("id-ID")}`, 
      callback_data: `buyvps_ram:${v.plan}` 
    }
  ]);

  keyboard.push([{ text: "🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", callback_data: "buyvps_start" }]);

  await editMenuMessage(ctx, teks, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard }
  });
});

bot.action(/buyvps_ram:(.+)/, async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buyvps_ram')) return;
  
  const plan = ctx.match[1];
  const userId = ctx.from.id;
  
  if (userState[userId]?.vpsData) {
    userState[userId].vpsData.plan = plan;
  }

  const osFamily = [
    { name: "Ubuntu", key: "ubuntu" },
    { name: "Debian", key: "debian" },
    { name: "CentOS Stream", key: "centos" },
    { name: "Fedora", key: "fedora" },
    { name: "AlmaLinux", key: "almalinux" },
    { name: "Rocky Linux", key: "rocky" },
  ];

  const keyboard = osFamily.map(os => [{
    text: os.name,
    callback_data: `buyvps_osfamily:${os.key}`
  }]);

  keyboard.push([
    { text: "🔙 Kembali", callback_data: `buyvps_pkg:${userState[userId]?.vpsData?.paket}` }
  ]);

  await editMenuMessage(ctx,
    `💾 *Spesifikasi Dipilih*: ${plan}\n\nPilih *OS Family*:`,
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard }
    }
  ); 
});

bot.action(/buyvps_osfamily:(.+)/, async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buyvps_osfamily')) return;
  
  const osKey = ctx.match[1];
  const userId = ctx.from.id;
  
  if (userState[userId]?.vpsData) {
    userState[userId].vpsData.osFamily = osKey;
  }

  const osVersions = {
    ubuntu: [
      { name: "Ubuntu 20.04", slug: "ubuntu-20-04-x64" },
      { name: "Ubuntu 22.04", slug: "ubuntu-22-04-x64" },
      { name: "Ubuntu 24.04", slug: "ubuntu-24-04-x64" },
    ],
    debian: [
      { name: "Debian 12", slug: "debian-12-x64" },
      { name: "Debian 13", slug: "debian-13-x64" },
    ],
    centos: [
      { name: "CentOS Stream 9", slug: "centos-stream-9-x64" },
    ],
    fedora: [
      { name: "Fedora 42", slug: "fedora-42-x64" },
    ],
    almalinux: [
      { name: "AlmaLinux 8", slug: "almalinux-8-x64" },
      { name: "AlmaLinux 9", slug: "almalinux-9-x64" },
    ],
    rocky: [
      { name: "Rocky Linux 8", slug: "rockylinux-8-x64" },
      { name: "Rocky Linux 9", slug: "rockylinux-9-x64" },
    ]
  };

  const versionList = osVersions[osKey] || [];

  const keyboard = versionList.map(v => [{
    text: v.name,
    callback_data: `buyvps_os:${v.slug}`
  }]);

  keyboard.push([
    { text: "🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶 𝗞𝗲 𝗢𝗦 𝗙𝗮𝗺𝗶𝗹𝘆", callback_data: `buyvps_ram:${userState[userId]?.vpsData?.plan}` }
  ]);

  await editMenuMessage(ctx,
    `🖥 *OS Dipilih*: ${osKey.toUpperCase()}\n\nPilih *Versi OS*:`,
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard }
    }
  );
});

bot.action(/buyvps_os:(.+)/, async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buyvps_os')) return;
  
  const osSlug = ctx.match[1];
  const userId = ctx.from.id;
  
  if (userState[userId]?.vpsData) {
    userState[userId].vpsData.os = osSlug;
  }

  const regionList = [
    { name: "𝗦𝗜𝗡𝗚𝗔𝗣𝗢𝗥𝗘 (𝗥𝗘𝗖𝗢𝗠𝗘𝗡𝗗𝗘𝗗)", code: "sgp1" },
    { name: "𝗡𝗘𝗪 𝗬𝗢𝗥𝗞", code: "nyc3" },
    { name: "𝗦𝗔𝗡 𝗙𝗥𝗔𝗡𝗖𝗜𝗦𝗖𝗢", code: "sfo3" },
    { name: "𝗔𝗠𝗦𝗧𝗘𝗥𝗗𝗔𝗠", code: "ams3" },
    { name: "𝗟𝗢𝗡𝗗𝗢𝗡", code: "lon1" },
    { name: "𝗙𝗥𝗔𝗡𝗞𝗙𝗨𝗥𝗧", code: "fra1" },
  ];

  let text = `📍 *PILIH REGION VPS*\n\n`;
  regionList.forEach((r, i) => text += `${i + 1}. ${r.name}\n`);

  if (userState[userId]?.vpsData) {
    userState[userId].vpsData.regionList = regionList;
  }

  const buttons = regionList.map((r, i) => [
    { text: `${i + 1}. ${r.name}`, callback_data: `buyvps_region:${r.code}` }
  ]);

  buttons.push([
    { text: "🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", callback_data: `buyvps_osfamily:${userState[userId]?.vpsData?.osFamily}` }
  ]);

  await editMenuMessage(ctx, text, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buttons }
  });
});

bot.action(/buyvps_region:(.+)/, async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buyvps_region')) return;
  
  const region = ctx.match[1];
  const userId = ctx.from.id;
  
  if (!userState[userId]?.vpsData) {
    return ctx.answerCbQuery("❌ Session VPS tidak ditemukan!", { show_alert: true });
  }

  const vpsData = userState[userId].vpsData;
  vpsData.region = region;

  const paket = vpsData.paket;
  const plan = vpsData.plan;
  const hargaRaw = config.hargaVPS?.[paket]?.[plan] || 0;
  
  vpsData.harga = hargaRaw;
  vpsData.username = ctx.from.username || ctx.from.first_name;

  const paketInfo = {
    low: { garansi: "7 Hari", replace: "unli" },
    medium: { garansi: "10 Hari", replace: "unli" },
    high: { garansi: "15 Hari", replace: "unli" }
  };

  const specList = {
    "2c2": "2GB 2 VCPU | 60GB SSD | 3TB BW",
    "4c2": "4GB 2 VCPU | 80GB SSD | 4TB BW",
    "8c4": "8GB 4 VCPU | 160GB SSD | 5TB BW",
    "16c4": "16GB 4 VCPU | 200GB SSD | 8TB BW",
    "16c8": "16GB 8 VCPU | 320GB SSD | 6TB BW"
  };

  const labelSpec = specList[plan] || "-";
  const harga = `Rp ${hargaRaw.toLocaleString("id-ID")}`;

  await editMenuMessage(ctx,
`✅ *KONFIRMASI PEMESANAN VPS*
━━━━━━━━━━━━━━━━━━━━━━

📦 *Paket*: ${paket.toUpperCase()}
💸 *Harga*: *${harga}*

🛡️ *Garansi*: ${paketInfo[paket].garansi}
♻️ *Replace*: ${paketInfo[paket].replace}

🖥 *Spesifikasi*
• ${labelSpec}
• CPU/RAM Code: *${plan}*

🧩 *OS Family*: ${vpsData.osFamily.toUpperCase()}
🖥 *OS Version*: ${vpsData.os}
🌍 *Region*: ${region}

━━━━━━━━━━━━━━━━━━━━━━.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "💰 𝗢𝗿𝗱𝗲𝗿 𝗩𝗽𝘀 𝗦𝗲𝗸𝗮𝗿𝗮𝗻𝗴", callback_data: "buyvps_pay_qris" }],
          [{ text: "🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", callback_data: `buyvps_os:${vpsData.os}` }]
        ]
      }
    }
  );
});

bot.action(/choose_service(_page_(\d+))?/, async (ctx) => {
  const page = ctx.match[2] ? parseInt(ctx.match[2]) : 1;
  const perPage = 20;
  const apiKey = config.RUMAHOTP;

  try {
    if (!ctx.match[2]) {
       await ctx.editMessageCaption("⏳ <b>Memuat daftar layanan...</b>", { parse_mode: "HTML" }).catch(() => {});
    }

    if (globalNokos.cachedServices.length === 0) {
      const res = await axios.get("https://www.rumahotp.com/api/v2/services", { headers: { "x-apikey": apiKey } });
      if (res.data.success) globalNokos.cachedServices = res.data.data;
    }

    const services = globalNokos.cachedServices;
    const totalPages = Math.ceil(services.length / perPage);
    const start = (page - 1) * perPage;
    const list = services.slice(start, start + perPage);

    const buttons = list.map(srv => [{
      text: `${srv.service_name}`,
      callback_data: `service_${srv.service_code}`
    }]);

    const nav = [];
    if (page > 1) nav.push({ text: "⬅️ 𝗣𝗿𝗲𝘃", callback_data: `choose_service_page_${page - 1}` });
    if (page < totalPages) nav.push({ text: "➡️ 𝗡𝗲𝘅𝘁 𝗹", callback_data: `choose_service_page_${page + 1}` });
    if (nav.length) buttons.push(nav);

    buttons.push([{ text: "💰 𝗗𝗲𝗽𝗼𝘀𝗶𝘁", callback_data: "topup_nokos" }]); 
    buttons.push([{ text: "🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", callback_data: "shop_menu" }]);

    const caption = `<b>📱 𝗗𝗔𝗙𝗧𝗔𝗥 𝗔𝗣𝗟𝗜𝗞𝗔𝗦𝗜 𝗢𝗧𝗣</b>\n\nSilakan pilih aplikasi:\nHalaman ${page}/${totalPages}`;

    globalNokos.lastServicePhoto[ctx.from.id] = { chatId: ctx.chat.id, messageId: ctx.callbackQuery.message.message_id };

    if (config.ppthumb && !ctx.match[2]) {
       await editMenuMessageWithPhoto(ctx, config.ppthumb, caption, { reply_markup: { inline_keyboard: buttons } });
    } else {
       await ctx.editMessageCaption(caption, { parse_mode: "HTML", reply_markup: { inline_keyboard: buttons } });
    }

  } catch (error) {
    console.error(error);
    await ctx.answerCbQuery("❌ Gagal memuat layanan.");
  }
});

bot.action(/service_(.+)/, async (ctx) => {
  const serviceId = ctx.match[1];
  const apiKey = config.RUMAHOTP;

  await ctx.editMessageCaption("⏳ <b>Memuat negara...</b>", { parse_mode: "HTML" }).catch(() => {});

  try {
    if (!globalNokos.cachedCountries[serviceId]) {
      const res = await axios.get(`https://www.rumahotp.com/api/v2/countries?service_id=${serviceId}`, {
        headers: { "x-apikey": apiKey }
      });
      if (res.data.success) {
         globalNokos.cachedCountries[serviceId] = res.data.data.filter(x => x.pricelist && x.pricelist.length > 0);
      }
    }

    const countries = globalNokos.cachedCountries[serviceId] || [];
    if (countries.length === 0) return ctx.editMessageCaption("❌ Negara tidak tersedia.", { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{text: "🔙 Kembali", callback_data: "choose_service"}]] } });

    const slice = countries.slice(0, 20);
    
    const buttons = slice.map(c => [{
      text: `${c.name} (${c.stock_total})`,
      callback_data: `country_${serviceId}_${c.iso_code}_${c.number_id}`
    }]);

    buttons.push([{ text: "🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", callback_data: "choose_service" }]);

    await ctx.editMessageCaption(`<b>🌍 𝗣𝗜𝗟𝗜𝗛 𝗡𝗘𝗚𝗔𝗥𝗔</b>\nLayanan ID: ${serviceId}`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (e) {
    ctx.answerCbQuery("Error memuat negara");
  }
});

bot.action(/country_(.+)_(.+)_(.+)/, async (ctx) => {
  const [_, serviceId, iso, numberId] = ctx.match;
  const apiKey = config.RUMAHOTP;
  const untung = config.UNTUNG_NOKOS || 500;

  await ctx.editMessageCaption("⏳ <b>Memuat harga...</b>", { parse_mode: "HTML" }).catch(() => {});

  try {
    let countryData = globalNokos.cachedCountries[serviceId]?.find(c => String(c.number_id) === String(numberId));
    
    if (!countryData) {
       const res = await axios.get(`https://www.rumahotp.com/api/v2/countries?service_id=${serviceId}`, { headers: { "x-apikey": apiKey } });
       countryData = res.data.data.find(c => String(c.number_id) === String(numberId));
    }

    if (!countryData) return ctx.answerCbQuery("Negara data error");

    const providers = (countryData.pricelist || [])
      .filter(p => p.available && p.stock > 0)
      .map(p => {
        const finalPrice = (parseInt(p.price) || 0) + untung;
        return { ...p, finalPrice };
      })
      .sort((a, b) => a.finalPrice - b.finalPrice);

    if (providers.length === 0) return ctx.editMessageCaption("❌ Stok kosong untuk negara ini.", { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{text: "🔙 Kembali", callback_data: `service_${serviceId}`}]] } });

    const buttons = providers.map(p => [{
      text: `${toRupiah(p.finalPrice)} (Stok: ${p.stock})`,
      callback_data: `buy_nokos_${numberId}_${p.provider_id}_${serviceId}_${p.finalPrice}`
    }]);

    buttons.push([{ text: "🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", callback_data: `service_${serviceId}` }]);

    await ctx.editMessageCaption(`<b>💵 𝗣𝗜𝗟𝗜𝗛 𝗛𝗔𝗥𝗚𝗔</b>\n𝗡𝗲𝗴𝗮𝗿𝗮 : ${countryData.name}\n\n𝗣𝗶𝗹𝗶𝗵 𝗛𝗮𝗿𝗴𝗮 𝗬𝗮𝗻𝗴 𝗞𝗮𝗺𝘂 𝗠𝗮𝘂 :`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons }
    });

  } catch (e) {
    ctx.answerCbQuery("Gagal memuat harga");
  }
});

bot.action(/buy_nokos_(.+)_(.+)_(.+)_(.+)/, async (ctx) => {
  const [_, numberId, providerId, serviceId, price] = ctx.match;
  
  const buttons = [
    [{ text: "✅ 𝗞𝗼𝗻𝗳𝗶𝗿𝗺𝗮𝘀𝗶 𝗢𝗿𝗱𝗲𝗿 (𝗥𝗮𝗻𝗱𝗼𝗺 𝗢𝗽𝗲𝗿𝗮𝘁𝗼𝗿)", callback_data: `confirm_nokos_${numberId}_${providerId}_${serviceId}_any_${price}` }],
    [{ text: "📡 𝗣𝗶𝗹𝗶𝗵 𝗢𝗽𝗲𝗿𝗮𝘁𝗼𝗿 𝗧𝗲𝗿𝘁𝗲𝗻𝘁𝘂", callback_data: `operator_${numberId}_${providerId}_${serviceId}_${price}` }],
    [{ text: "🔙 𝗕𝗮𝘁𝗮𝗹 𝗢𝗿𝗱𝗲𝗿", callback_data: "choose_service" }]
  ];

  await ctx.editMessageCaption(`<b>🛒 𝗞𝗢𝗡𝗙𝗢𝗥𝗠𝗔𝗦𝗜 𝗢𝗥𝗗𝗘𝗥</b>\n└⌑ 💰 𝖧𝖺𝗋𝗀𝖺 : ${toRupiah(price)}\n\n𝖫𝖺𝗇𝗃𝗎𝗍𝗄𝖺𝗇 𝖮𝗋𝖽𝖾𝗋`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons }
  });
});

bot.action(/operator_(.+)_(.+)_(.+)_(.+)/, async (ctx) => {
  const [_, numberId, providerId, serviceId, price] = ctx.match;
  const apiKey = config.RUMAHOTP;

  try {
     const countryData = globalNokos.cachedCountries[serviceId]?.find(c => String(c.number_id) === String(numberId));
     if (!countryData) return ctx.answerCbQuery("Data negara hilang, ulangi dari awal.");

     const res = await axios.get(`https://www.rumahotp.com/api/v2/operators?country=${encodeURIComponent(countryData.name)}&provider_id=${providerId}`, { headers: { "x-apikey": apiKey } });
     
     const ops = res.data.data || [];
     if(ops.length === 0) return ctx.answerCbQuery("Operator spesifik tidak tersedia, gunakan random.");

     const buttons = ops.map(op => [{
        text: op.name,
        callback_data: `confirm_nokos_${numberId}_${providerId}_${serviceId}_${op.id}_${price}`
     }]);
     buttons.push([{text: "🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", callback_data: `buy_nokos_${numberId}_${providerId}_${serviceId}_${price}`}]);

     await ctx.editMessageCaption(`<b>📡 𝗣𝗜𝗟𝗜𝗛 𝗢𝗣𝗘𝗥𝗔𝗧𝗢𝗥</b>\n└⌑ 𝖯𝗋𝗈𝗏𝗂𝖽𝖾𝗋 𝖨𝖣 : ${providerId}`, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons }
     });

  } catch(e) {
     ctx.answerCbQuery("Gagal load operator");
  }
});

bot.action(/confirm_nokos_(.+)_(.+)_(.+)_(.+)_(.+)/, async (ctx) => {
  const [_, numberId, providerId, serviceId, operatorId, priceStr] = ctx.match;
  const price = parseInt(priceStr);
  const userId = ctx.from.id;
  const apiKey = config.RUMAHOTP;

  const saldoData = JSON.parse(fs.readFileSync("./database/saldoOtp.json", "utf8") || "{}");
  const userSaldo = saldoData[userId] || 0;

  if (userSaldo < price) {
    return ctx.answerCbQuery("🚫 𝗦𝗮𝗹𝗱𝗼 𝗞𝗮𝗺𝘂 𝗦𝗲𝗸𝗮𝗿𝗮𝗻𝗴 𝗥𝗽.𝟬, 𝗝𝗮𝗱𝗶 𝗗𝗲𝗽𝗼𝘀𝗶𝘁 𝗧𝗲𝗿𝗹𝗲𝗯𝗶𝗵 𝗗𝗮𝗵𝘂𝗹𝘂.", { show_alert: true });
  }

  await ctx.editMessageCaption("⏳ <b>𝗦𝗲𝗱𝗮𝗻𝗴 𝗠𝗲𝗺𝗽𝗿𝗼𝘀𝗲𝘀 𝗣𝗲𝗺𝗯𝗲𝗹𝗶𝗮𝗻...</b>", { parse_mode: "HTML" }).catch(()=>{});

  try {
    saldoData[userId] = userSaldo - price;
    fs.writeFileSync("./database/saldoOtp.json", JSON.stringify(saldoData, null, 2));

    let url = `https://www.rumahotp.com/api/v2/orders?number_id=${numberId}&provider_id=${providerId}`;
    if (operatorId && operatorId !== 'any') {
        url += `&operator_id=${operatorId}`;
    }
    
    const res = await axios.get(url, { headers: { "x-apikey": apiKey } });

    if (!res.data.success) {
      saldoData[userId] += price;
      fs.writeFileSync("./database/saldoOtp.json", JSON.stringify(saldoData, null, 2));
      
      const errMsg = res.data.message || res.data.msg || "Stok habis atau gangguan provider";
      
      return ctx.editMessageCaption(`❌ <b>𝗢𝗿𝗱𝗲𝗿 𝗚𝗮𝗴𝗮𝗹 :</b> ${errMsg}\n└⌑ 𝖲𝖺𝗅𝖽𝗈 𝖡𝖾𝗋𝗁𝖺𝗌𝗂𝗅 𝖣𝗂𝗄𝖾𝗆𝖻𝖺𝗅𝗂𝗄𝖺𝗇`, { 
          parse_mode: "HTML", 
          reply_markup: { inline_keyboard: [[{text:"🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", callback_data:"choose_service"}]] } 
      });
    }

    const d = res.data.data;
    
    globalNokos.activeOrders[d.order_id] = {
      userId,
      price,
      messageId: ctx.callbackQuery.message.message_id,
      startTime: Date.now()
    };

    const text = `✅ <b>𝗢𝗥𝗗𝗘𝗥 𝗕𝗘𝗥𝗛𝗔𝗦𝗜𝗟</b>\n├⌑ 🆔 𝖨𝖣 : <code>${d.order_id}</code>\n├⌑ 📞 𝖭𝗈𝗆𝗈𝗋: <code>${d.phone_number}</code>\n├⌑ 📱 𝖠𝗉𝗉𝗌 : ${d.service}\n├⌑ 💰 𝖧𝖺𝗋𝗀𝖺 : ${toRupiah(price)}\n└⌑ ⏳ 𝖲𝗍𝖺𝗍𝗎𝗌 : Menunggu 𝖪𝗈𝖽𝖾 𝖲𝖬𝖲...`;

    await ctx.editMessageCaption(text, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📩 𝗖𝗲𝗸 𝗦𝗠𝗦", callback_data: `check_sms_${d.order_id}` }],
          [{ text: "❌ 𝗕𝗮𝘁𝗮𝗹𝗸𝗮𝗻", callback_data: `cancel_sms_${d.order_id}` }]
        ]
      }
    });

  } catch (e) {
    console.error("Order Error:", e);
    const saldoCurrent = JSON.parse(fs.readFileSync("./database/saldoOtp.json", "utf8") || "{}");
    saldoCurrent[userId] = (saldoCurrent[userId] || 0) + price;
    fs.writeFileSync("./database/saldoOtp.json", JSON.stringify(saldoCurrent, null, 2));

    ctx.editMessageCaption(`❌ <b>𝗦𝘆𝘀𝘁𝗲𝗺 𝗘𝗿𝗿𝗼𝗿 :</b> ${e.message}\n└⌑ 𝖲𝖺𝗅𝖽𝗈 𝖡𝖾𝗋𝗁𝖺𝗌𝗂𝗅 𝖣𝗂𝗄𝖾𝗆𝖻𝖺𝗅𝗂𝗄𝖺𝗇.`);
  }
});

bot.action(/check_sms_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const apiKey = config.RUMAHOTP;

  try {
    const res = await axios.get(`https://www.rumahotp.com/api/v1/orders/get_status?order_id=${orderId}`, {
       headers: { "x-apikey": apiKey }
    });

    const d = res.data.data;
    if (d.status === "completed" || (d.otp_code && d.otp_code !== "-")) {
       await ctx.editMessageCaption(`✅ <b>𝗦𝗠𝗦 𝗗𝗜𝗧𝗘𝗥𝗜𝗠𝗔!</b>\n├⌑ 📞 𝖭𝗈𝗆𝗈𝗋 : <code>${d.phone_number}</code>\n├⌑ 💬 <b>𝖮𝖳𝖯 :</b> <code>${d.otp_code}</code>\n└⌑ ⏳ 𝖲𝗍𝖺𝗍𝗎𝗌 : 𝖳𝗋𝖺𝗇𝗌𝖺𝗄𝗌𝗂 𝖲𝖾𝗅𝖾𝗌𝖺𝗂.`, { parse_mode: "HTML" });
       delete globalNokos.activeOrders[orderId];
    } else if (d.status === 'processing') {
       await ctx.answerCbQuery("⏳ 𝗦𝗠𝗦 𝗕𝗲𝗹𝘂𝗺 𝗠𝗮𝘀𝘂𝗸, 𝗦𝗶𝗹𝗮𝗵𝗸𝗮𝗻 𝗖𝗼𝗯𝗮 𝗟𝗮𝗴𝗶", { show_alert: false });
    } else {
       await ctx.editMessageCaption(`ℹ️ 𝗦𝘁𝗮𝘁𝘂𝘀 𝗢𝗿𝗱𝗲𝗿 : ${d.status}`, { parse_mode: "HTML" });
    }

  } catch(e) {
    ctx.answerCbQuery("Gagal cek status");
  }
});

bot.action(/cancel_sms_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const apiKey = config.RUMAHOTP;
  const userId = ctx.from.id;

  const orderInfo = globalNokos.activeOrders[orderId];
  if (orderInfo && (Date.now() - orderInfo.startTime < 300000)) {
      return ctx.answerCbQuery("⏳ Tunggu 5 menit baru bisa cancel!", { show_alert: true });
  }

  try {
    const res = await axios.get(`https://www.rumahotp.com/api/v1/orders/set_status?order_id=${orderId}&status=cancel`, {
       headers: { "x-apikey": apiKey }
    });

    if (res.data.success) {
       if (orderInfo) {
          const saldoData = JSON.parse(fs.readFileSync("./database/saldoOtp.json", "utf8"));
          saldoData[userId] = (saldoData[userId] || 0) + orderInfo.price;
          fs.writeFileSync("./database/saldoOtp.json", JSON.stringify(saldoData, null, 2));
          delete globalNokos.activeOrders[orderId];
       }
       await ctx.editMessageCaption("✅ <b>Order Dibatalkan & Saldo Direfund.</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{text:"🔙 Menu", callback_data:"choose_service"}]] } });
    } else {
       ctx.answerCbQuery("Gagal cancel: " + res.data.message);
    }
  } catch(e) {
    ctx.answerCbQuery("Error cancel");
  }
});

bot.action("topup_nokos", async (ctx) => {
    if (ctx.chat.type !== 'private') {
        return ctx.reply("❌ Menu deposit hanya bisa diakses via Private Chat (PC).", {
            reply_markup: {
                inline_keyboard: [[{ text: "📩 𝗖𝗵𝗮𝘁 𝗕𝗼𝘁 𝗦𝗲𝗸𝗮𝗿𝗮𝗻𝗴", url: `https://t.me/${ctx.botInfo.username}` }]]
            }
        });
    }

    const userId = ctx.from.id;
    userState[userId] = { step: "WAITING_TOPUP_RUMAHOTP" };

    await editMenuMessage(ctx, 
        `💰 <b>𝗗𝗘𝗣𝗢𝗦𝗜𝗧 𝗦𝗔𝗟𝗗𝗢</b>\n\nSilakan masukkan nominal deposit (Hanya Angka).\nMinimal: Rp 2.000\n\nContoh: <code>2000</code>`, 
        {
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "❌ 𝗕𝗮𝘁𝗮𝗹 𝗗𝗲𝗽𝗼𝘀𝗶𝘁", callback_data: "shop_menu" }]
                ]
            }
        }
    );
});

bot.action(/batal_depo_rumahotp_(.+)/, async (ctx) => {
   const depoId = ctx.match[1];
   const apiKey = config.RUMAHOTP;
   try {
     await axios.get(`https://www.rumahotp.com/api/v1/deposit/cancel?deposit_id=${depoId}`, { headers: { "x-apikey": apiKey } });
     await ctx.deleteMessage();
     await ctx.reply("✅ Deposit dibatalkan.", {reply_markup: {inline_keyboard: [[{text:"🔙 Menu", callback_data:"shop_menu"}]]}});
   } catch(e) {
     ctx.answerCbQuery("Gagal batal");
   }
});

bot.action(/smm_services_(\d+)/, async (ctx) => {
    const page = parseInt(ctx.match[1]);
    await ctx.answerCbQuery("⏳ Memuat layanan...").catch(()=>{});
    
    const res = await callSmmApi('/services'); 
    
    let services = [];
    if (res.status === true && res.data) services = res.data;
    else if (Array.isArray(res)) services = res;
    else if (res.services) services = res.services;

    if (!services || services.length === 0) {
        return ctx.reply("❌ Gagal mengambil layanan. Cek Config API ID/Key.");
    }

    const categories = [...new Set(services.map(s => s.category))];
    const perPage = 5;
    const paginated = categories.slice(page * perPage, (page + 1) * perPage);

    const buttons = paginated.map((cat) => [
        Markup.button.callback(`📂 ${cat}`, `smm_cat_${categories.indexOf(cat)}_0`)
    ]);

    const nav = [];
    if (page > 0) nav.push(Markup.button.callback('⬅️ 𝗣𝗿𝗲𝘃', `smm_services_${page - 1}`));
    if ((page + 1) * perPage < categories.length) nav.push(Markup.button.callback('Next ➡️', `smm_services_${page + 1}`));
    if (nav.length > 0) buttons.push(nav);
    buttons.push([Markup.button.callback('🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶', 'smm_menu')]);

    await editMenuMessage(ctx, "<b>📂 𝗣𝗜𝗟𝗜𝗛 𝗞𝗔𝗧𝗘𝗚𝗢𝗥𝗜 𝗟𝗔𝗬𝗔𝗡𝗔𝗡 :</b>", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons }
    });
});

bot.action(/smm_cat_(\d+)_(\d+)/, async (ctx) => {
    const catIndex = parseInt(ctx.match[1]);
    const page = parseInt(ctx.match[2]);
    
    const res = await callSmmApi('/services');
    let services = res.data || res.services || (Array.isArray(res) ? res : []);
    
    const categories = [...new Set(services.map(s => s.category))];
    const targetCat = categories[catIndex];
    const filtered = services.filter(s => s.category === targetCat);
    
    const perPage = 5;
    const paginated = filtered.slice(page * perPage, (page + 1) * perPage);

    let text = `<b>📦 𝖪𝖠𝖳𝖤𝖦𝖮𝖱𝖨 : ${targetCat}</b>\n\n`;
    const buttons = paginated.map(s => {
        text += `🆔 <b>𝖨𝖣 : ${s.id}</b>\n🏷 ${s.name}\n💰 ${toRupiah(s.price)}/1000\nMin: ${s.min} | Max: ${s.max}\n\n`;
        return [Markup.button.callback(`𝖡𝖾𝗅𝗂 𝖨𝖣: ${s.id}`, `smm_buy_${s.id}`)];
    });

    const nav = [];
    if (page > 0) nav.push(Markup.button.callback('⬅️ 𝗣𝗿𝗲𝘃', `smm_cat_${catIndex}_${page - 1}`));
    if ((page + 1) * perPage < filtered.length) nav.push(Markup.button.callback('Next ➡️', `smm_cat_${catIndex}_${page + 1}`));
    if (nav.length > 0) buttons.push(nav);
    buttons.push([Markup.button.callback('🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶', `smm_services_0`)]);

    try { await ctx.deleteMessage(); } catch(e){}
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: { inline_keyboard: buttons } });
});

bot.action(/smm_buy_(\d+)/, async (ctx) => {
    const serviceId = ctx.match[1];
    userState[ctx.from.id] = { step: "SMM_WAITING_LINK", serviceId: serviceId };
    
    await editMenuMessage(ctx, 
        `🔗 <b>𝗦𝗜𝗟𝗔𝗛𝗞𝗔𝗡 𝗞𝗜𝗥𝗜𝗠 𝗟𝗜𝗡𝗞 𝗧𝗔𝗥𝗚𝗘𝗧</b>\n\n☘︎ Silakan kirim link/username target untuk layanan ID <b>${serviceId}</b>.\n\n<i>Ketik /batal untuk membatalkan.</i>`, 
        {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[Markup.button.callback('❌ 𝗕𝗮𝘁𝗮𝗹𝗸𝗮𝗻', 'smm_menu')]] }
        }
    );
});

bot.action("smm_history", async (ctx) => {
    const history = getSmmHistory(ctx.from.id);
    if (history.length === 0) return ctx.answerCbQuery("Belum ada riwayat.", { show_alert: true });

    let msg = "<b>📜 𝟱 𝗥𝗜𝗪𝗔𝗬𝗔𝗧 𝗧𝗘𝗥𝗔𝗞𝗛𝗜𝗥</b>\n\n";
    history.slice(0, 5).forEach(h => {
        msg += `🆔 <b>#${h.orderId}</b>\n📦 ${h.serviceName}\n💰 ${h.price}\n📅 ${h.date}\n\n`;
    });

    await editMenuMessage(ctx, msg, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[Markup.button.callback('🔙 Kembali', 'smm_menu')]] }
    });
});

bot.action("smm_check_status", (ctx) => {
    userState[ctx.from.id] = { step: "SMM_WAITING_STATUS_ID" };
    ctx.reply("🔍 <b>Kirim ID Pesanan:</b>", { 
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[Markup.button.callback('❌ Batal', 'smm_menu')]] } 
    });
});

bot.action("smm_exec_order", async (ctx) => {
    const userId = ctx.from.id;
    const pending = userState[userId]?.pendingOrder;

    if (!pending) {
        return ctx.answerCbQuery("❌ Sesi habis, ulangi pesanan.", { show_alert: true });
    }

    const dbSaldoPath = "./database/saldoOtp.json";
    const saldoData = JSON.parse(fs.readFileSync(dbSaldoPath, "utf8") || "{}");
    const userSaldo = saldoData[userId] || 0;

    if (userSaldo < pending.price) {
        return ctx.answerCbQuery("❌ Saldo tidak cukup!", { show_alert: true });
    }

    await ctx.editMessageText("⏳ <b>Memproses pesanan...</b>", { parse_mode: "HTML" });

    const orderRes = await callSmmApi('/order', {
        service: pending.serviceId,
        target: pending.target,
        quantity: pending.quantity
    });

    if (orderRes.status === true) {
        saldoData[userId] = userSaldo - pending.price;
        fs.writeFileSync(dbSaldoPath, JSON.stringify(saldoData, null, 2));

        const orderId = orderRes.order;
        saveSmmHistory(userId, {
            orderId: orderId, 
            serviceName: pending.serviceName,
            price: toRupiah(pending.price),
            date: new Date().toLocaleString("id-ID")
        });

        await ctx.editMessageText(
            `✅ <b>𝗢𝗥𝗗𝗘𝗥 𝗦𝗨𝗞𝗦𝗘𝗦!</b>\n` +
            `├⌑ 🆔 <b>𝖨𝖣 𝖮𝗋𝖽𝖾𝗋 :</b> <code>${orderId}</code>\n` +
            `├⌑ 📦 <b>𝖫𝖺𝗒𝖺𝗇𝖺𝗇 :</b> ${pending.serviceName}\n` +
            `├⌑ 💰 <b>𝖧𝖺𝗋𝗀𝖺 :</b> ${toRupiah(pending.price)}\n` +
            `└⌑ 📉 <b>𝖲𝗂𝗌𝖺 𝖲𝖺𝗅𝖽𝗈:</b> ${toRupiah(saldoData[userId])}`,
            { 
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [[{ text: "🔙 Kembali ke Menu", callback_data: "smm_menu" }]] }
            }
        );
    } else {
        const errorMsg = orderRes.msg || "Gagal memproses order.";
        await ctx.editMessageText(
            `❌ <b>𝗢𝗥𝗗𝗘𝗥 𝗚𝗔𝗚𝗔𝗟!</b>\n└⌑ Alasan: ${errorMsg}\n\n<i>Saldo tidak terpotong.</i>`,
            { 
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [[{ text: "🔙 𝗖𝗼𝗯𝗮 𝗟𝗮𝗴𝗶", callback_data: "smm_menu" }]] }
            }
        );
    }
    
    delete userState[userId];
});

bot.action("add_script", (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  userState[ctx.from.id] = { step: "WAITING_SCRIPT_FILE" };
  safeReply(ctx, `<blockquote><b>📥 𝗖𝗔𝗥𝗔 𝗠𝗘𝗡𝗔𝗠𝗕𝗔𝗛𝗞𝗔𝗡 𝗦𝗖𝗥𝗜𝗣𝗧</b>\n<b>├⌑ 𝖪𝗂𝗋𝗂𝗆 𝖥𝗂𝗅𝖾 𝖲𝖼𝗋𝗂𝗉𝗍 (𝖶𝖺𝗃𝗂𝖻 .𝗓𝗂𝗉) </b>\n<b>└⌑ 𝖩𝗂𝗄𝖺 𝖲𝗎𝖽𝖺𝗁, 𝖡𝗈𝗍 𝖠𝗄𝖺𝗇 𝖬𝖾𝗆𝗂𝗇𝗍𝖺 𝖣𝖾𝗍𝖺𝗂𝗅 𝖲𝖼𝗋𝗂𝗉𝗍</b></blockquote>`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("🔙 𝗕𝗮𝘁𝗮𝗹 𝗠𝗲𝗻𝗮𝗺𝗯𝗮𝗵𝗸𝗮𝗻 𝗦𝗰𝗿𝗶𝗽𝘁", "menu_owner")]]) }
  );
});

bot.action("add_app", (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  userState[ctx.from.id] = { step: "WAITING_APP_TEXT" };
  safeReply(ctx, "<blockquote><b>✏️ 𝗦𝗶𝗹𝗮𝗵𝗸𝗮𝗻 𝗞𝗶𝗿𝗶𝗺 𝗔𝗽𝗽𝘀 𝗣𝗿𝗲𝗺𝗶𝘂𝗺 𝗗𝗲𝗻𝗴𝗮𝗻 𝗙𝗼𝗿𝗺𝗮𝘁 :</b>\n<code>└⌑ 𝖭𝖺𝗆𝖺 | 𝖧𝖺𝗋𝗀𝖺 | 𝖣𝖾𝗌𝗄𝗋𝗂𝗉𝗌𝗂</code>\n\n<b>🍂 𝖤𝗑𝖺𝗆𝗉𝗅𝖾 :</b>\n<code>𝖢𝖠𝖭𝖵𝖠 𝖯𝖱𝖮 | 𝟥𝟢𝟢𝟢 | 𝖠𝗄𝗌𝖾𝗌 𝖯𝗋𝖾𝗆𝗂𝗎𝗆 𝖠𝖼𝗍𝗂𝗏𝖾</code></blockquote>", { parse_mode: "HTML" });
});

bot.action("del_script", (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  const db = readDb();
  if (db.scripts.length === 0) return ctx.editMessageText("Belum ada produk script.", Markup.inlineKeyboard([[Markup.button.callback("🔙 Kembali", "menu_owner")]]));

  const buttons = db.scripts.map((sc, i) => [Markup.button.callback(`❌ ${sc.nama}`, `delete_sc_${i}`)]);
  buttons.push([Markup.button.callback("🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", "menu_owner")]);
  ctx.editMessageText("<blockquote><b>🗑️ 𝗣𝗶𝗹𝗶𝗵 𝗦𝗰𝗿𝗶𝗽𝘁 𝗬𝗮𝗻𝗴 𝗜𝗻𝗴𝗶𝗻 𝗔𝗻𝗱𝗮 𝗛𝗮𝗽𝘂𝘀 :</b></blockquote>", { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) })
    .catch(() => {
      safeReply(ctx, "<blockquote><b>🗑️ 𝗣𝗶𝗹𝗶𝗵 𝗦𝗰𝗿𝗶𝗽𝘁 𝗬𝗮𝗻𝗴 𝗜𝗻𝗴𝗶𝗻 𝗔𝗻𝗱𝗮 𝗛𝗮𝗽𝘂𝘀 :</b></blockquote>", { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
    });
});

bot.action("del_app", (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  const db = readDb();
  if ((db.apps || []).length === 0) return ctx.editMessageText("Belum ada app.", Markup.inlineKeyboard([[Markup.button.callback("🔙 Kembali", "menu_owner")]]));

  const buttons = db.apps.map((a, i) => [Markup.button.callback(`❌ ${a.nama}`, `delete_app_${i}`)]);
  buttons.push([Markup.button.callback("🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", "menu_owner")]);
  ctx.editMessageText("<blockquote><b>🗑️ 𝗣𝗶𝗹𝗶𝗵 𝗔𝗽𝗽𝘀 𝗣𝗿𝗲𝗺𝗶𝘂𝗺 𝗬𝗮𝗻𝗴 𝗜𝗻𝗴𝗶𝗻 𝗗𝗶𝗵𝗮𝗽𝘂𝘀 :</b></blockquote>", { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
});

bot.action("list_apps", (ctx) => {
  const db = readDb();
  if ((db.apps || []).length === 0) return safeReply(ctx, "Tidak ada app.");
  const isOwner = ctx.from.id === config.ownerId;
  db.apps.forEach((x, i) => {
    const stock = (x.accounts || []).length;
    const text = `<blockquote><b>📱 ${x.nama}</b>\n<b>├⌑ 💰 𝖧𝖺𝗋𝗀𝖺 :</b> ${toRupiah(x.harga)}\n<b>└⌑ 📦 𝖲𝗍𝗈𝖼𝗄 :</b> ${stock}\n${x.deskripsi || ''}</blockquote>`;
    const buttons = [];
    if (isOwner) {
      buttons.push([ Markup.button.callback("📄 𝗟𝗶𝘀𝘁 𝗔𝗰𝗰𝗼𝘂𝗻𝘁", `list_accounts_${i}`) ]);
    }
    safeReply(ctx, text, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
  });
});

bot.action("buyvps_pay_qris", async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buyvps_pay_qris')) return;
  
  const userId = ctx.from.id;
  
  if (!userState[userId]?.vpsData) {
    return ctx.answerCbQuery("❌ 𝗗𝗮𝘁𝗮 𝗩𝗽𝘀 𝗧𝗶𝗱𝗮𝗸 𝗗𝗶𝘁𝗲𝗺𝘂𝗸𝗮𝗻!", { show_alert: true });
  }

  const vpsData = userState[userId].vpsData;
  const nominal = vpsData.harga;
  const itemName = `VPS ${vpsData.paket.toUpperCase()} - ${vpsData.plan} - ${vpsData.region}`;

  await handlePayment(ctx, nominal, itemName, {
    type: "vps",
    vpsData: vpsData
  });
});

bot.action(/buy_sc_(\d+)/, async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buy_sc')) return;
  
  const index = parseInt(ctx.match[1]);
  const db = readDb();
  const item = db.scripts[index];
  if (!item || !item.file_id) return safeReply(ctx, "Script tidak ditemukan/file hilang.");
  
  await handlePayment(ctx, item.harga, "Script: " + item.nama, {
    type: "script",
    index: index
  });
});

bot.action(/buy_app_(\d+)/, async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buy_app')) return;
  
  const idx = parseInt(ctx.match[1]);
  const db = readDb();
  const app = db.apps[idx];
  if (!app) return ctx.answerCbQuery("❌ App tidak ditemukan.");
  const stock = (app.accounts || []).length;
  if (stock <= 0) return ctx.answerCbQuery("❌ Stock habis.");

  userState[ctx.from.id] = {
    step: "PURCHASE_APP",
    appIndex: idx,
    qty: 1,
    message: null
  };

  const base = parseInt(app.harga) || 0;
  const qty = 1;
  const total = calcTotalPrice(base, qty);
  const caption = renderPurchaseText(app, qty, total);
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [ 
          { text: "➖", callback_data: `app_qty_minus_${idx}` }, 
          { text: `${qty}`, callback_data: `app_qty_show_${idx}` }, 
          { text: "➕", callback_data: `app_qty_plus_${idx}` } 
        ],
        [ { text: "🛒 𝗢𝗿𝗱𝗲𝗿 𝗦𝗲𝗸𝗮𝗿𝗮𝗻𝗴", callback_data: `app_buy_now_${idx}` } ],
        [ { text: "🔙 𝗕𝗮𝘁𝗮𝗹 𝗢𝗿𝗱𝗲𝗿", callback_data: "back_home" } ]
      ]
    }
  };

  await editMenuMessage(ctx, caption, {
    parse_mode: "HTML",
    ...keyboard
  });
  
  ctx.answerCbQuery().catch(()=>{});
});

bot.action(/app_qty_minus_(\d+)/, async (ctx) => {
  const uid = ctx.from.id;
  const idx = parseInt(ctx.match[1]);
  if (!userState[uid] || userState[uid].step !== "PURCHASE_APP" || userState[uid].appIndex !== idx) {
    userState[uid] = { step: "PURCHASE_APP", appIndex: idx, qty: 1, message: null };
  }
  const db = readDb();
  const app = db.apps[idx];
  if (!app) {
    ctx.answerCbQuery("🚫 𝗔𝗽𝗽𝘀 𝗣𝗿𝗲𝗺𝗶𝘂𝗺 𝗧𝗶𝗱𝗮𝗸 𝗗𝗶𝘁𝗲𝗺𝘂𝗸𝗮𝗻.");
    return;
  }
  userState[uid].qty = Math.max(1, (userState[uid].qty || 1) - 1);
  const qty = userState[uid].qty;
  const base = parseInt(app.harga) || 0;
  const stock = (app.accounts || []).length;
  if (qty > stock) userState[uid].qty = stock;
  const total = calcTotalPrice(base, userState[uid].qty);
  const caption = renderPurchaseText(app, userState[uid].qty, total);

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [ 
          { text: "➖", callback_data: `app_qty_minus_${idx}` }, 
          { text: `${userState[uid].qty}`, callback_data: `app_qty_show_${idx}` }, 
          { text: "➕", callback_data: `app_qty_plus_${idx}` } 
        ],
        [ { text: "🛒 Buy Now", callback_data: `app_buy_now_${idx}` } ],
        [ { text: "🔙 Batal", callback_data: "back_home" } ]
      ]
    }
  };

  await editMenuMessage(ctx, caption, {
    parse_mode: "HTML",
    ...keyboard
  });
  
  ctx.answerCbQuery().catch(()=>{});
});

bot.action(/app_qty_plus_(\d+)/, async (ctx) => {
  const uid = ctx.from.id;
  const idx = parseInt(ctx.match[1]);
  if (!userState[uid] || userState[uid].step !== "PURCHASE_APP" || userState[uid].appIndex !== idx) {
    userState[uid] = { step: "PURCHASE_APP", appIndex: idx, qty: 1, message: null };
  }
  const db = readDb();
  const app = db.apps[idx];
  if (!app) {
    ctx.answerCbQuery("🚫 𝗔𝗽𝗽𝘀 𝗣𝗿𝗲𝗺𝗶𝘂𝗺 𝗧𝗶𝗱𝗮𝗸 𝗗𝗶𝘁𝗲𝗺𝘂𝗸𝗮𝗻");
    return;
  }
  const stock = (app.accounts || []).length;
  userState[uid].qty = (userState[uid].qty || 1) + 1;
  if (userState[uid].qty > stock) userState[uid].qty = stock;
  const total = calcTotalPrice(parseInt(app.harga) || 0, userState[uid].qty);
  const caption = renderPurchaseText(app, userState[uid].qty, total);

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [ 
          { text: "➖", callback_data: `app_qty_minus_${idx}` }, 
          { text: `${userState[uid].qty}`, callback_data: `app_qty_show_${idx}` }, 
          { text: "➕", callback_data: `app_qty_plus_${idx}` } 
        ],
        [ { text: "🛒 𝗢𝗿𝗱𝗲𝗿 𝗦𝗲𝗸𝗮𝗿𝗮𝗻𝗴", callback_data: `app_buy_now_${idx}` } ],
        [ { text: "🔙 𝗕𝗮𝘁𝗮𝗹 𝗢𝗿𝗱𝗲𝗿", callback_data: "back_home" } ]
      ]
    }
  };

  await editMenuMessage(ctx, caption, {
    parse_mode: "HTML",
    ...keyboard
  });
  
  ctx.answerCbQuery().catch(()=>{});
});

bot.action(/app_qty_show_(\d+)/, (ctx) => {
  ctx.answerCbQuery().catch(()=>{});
});

bot.action(/app_buy_now_(\d+)/, async (ctx) => {
  if (!await requirePrivateChat(ctx, 'app_buy_now')) return;
  
  const uid = ctx.from.id;
  const idx = parseInt(ctx.match[1]);
  const db = readDb();
  const app = db.apps[idx];
  if (!app) return ctx.answerCbQuery("🚫 𝗔𝗽𝗽𝘀 𝗧𝗶𝗱𝗮𝗸 𝗗𝗶𝘁𝗲𝗺𝘂𝗸𝗮𝗻.");
  const stock = (app.accounts || []).length;
  const st = userState[uid];
  if (!st || st.step !== "PURCHASE_APP" || st.appIndex !== idx) {
    userState[uid] = { step: "PURCHASE_APP", appIndex: idx, qty: 1, message: null };
  }
  const qty = Math.max(1, userState[uid].qty || 1);
  if (qty > stock) return ctx.answerCbQuery("🚫 𝗝𝘂𝗺𝗹𝗮𝗵 𝗗𝗲𝗽𝗼𝘀𝗶𝘁 𝗠𝗲𝗹𝗲𝗯𝗶𝗵𝗶 𝗦𝘁𝗼𝗰𝗸.");
  const total = calcTotalPrice(parseInt(app.harga) || 0, qty);

  await handlePayment(ctx, total, `App: ${app.nama} x${qty}`, {
    type: "app",
    idx: idx,
    qty: qty,
    total: total
  });

  ctx.answerCbQuery().catch(()=>{});
});

bot.action("buy_reseller_panel", async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buy_reseller_panel')) return;

  const harga = config.hargaResellerPanel || 25000;

  await editMenuMessage(ctx,
    `<blockquote><b>🤝 𝗔𝗞𝗦𝗘𝗦 𝗥𝗘𝗦𝗘𝗟𝗟𝗘𝗥 𝗣𝗔𝗡𝗘𝗟</b>
━━━━━━━━━━━━━━━━━━━━━━━━
<b>💎 𝗞𝗲𝘂𝗻𝘁𝘂𝗻𝗴𝗮𝗻 𝗝𝗼𝗶𝗻 𝗥𝗲𝘀𝗲𝗹𝗹𝗲𝗿 𝗣𝗮𝗻𝗲𝗹:</b>
├≫ Bisa Menjual Panel
├≫ 𝖡𝗂𝗌𝖺 Open Sewa Bot
├≫ 𝖡𝗂𝗌𝖺 Create Panel Sepuasnya
├≫ Anti Ptpt
└≫ 𝖩𝖺𝗆𝗂𝗇 𝖡𝖺𝗅𝗆𝗈𝖽 𝖪𝖺𝗅𝗈 𝖠𝖽𝖺 𝖴𝗌𝖺𝗁𝖺

<b>💰 𝗛𝗮𝗿𝗴𝗮 𝗝𝗼𝗶𝗻 :</b> ${toRupiah(harga)}
<i>╰┈⸙ 𝖢𝗎𝗄𝗎𝗉 𝖡𝖺𝗒𝖺𝗋 𝖲𝖾𝗄𝖺𝗅𝗂 𝖲𝖺𝗃𝖺
𝖳𝖾𝗍𝖺𝗉𝗂 𝖣𝗎𝗋𝖺𝗌𝗂 𝖯𝖾𝗋𝗆𝖺𝗇𝖾𝗇</i>
━━━━━━━━━━━━━━━━━━━━━━
<b>🚀 𝖲𝗂𝗅𝖺𝗁𝗄𝖺𝗇 𝖳𝖾𝗄𝖺𝗇 𝖲𝖺𝗅𝖺𝗁 𝖲𝖺𝗍𝗎 𝖡𝗎𝗍𝗍𝗈𝗇
𝖣𝗂𝖻𝖺𝗐𝖺𝗁 𝖨𝗇𝗂 𝖴𝗇𝗍𝗎𝗄 𝖬𝖾𝗅𝖺𝗇𝗃𝗎𝗍𝗄𝖺𝗇 :</b></blockquote>`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ 𝗞𝗼𝗻𝗳𝗼𝗿𝗺𝗮𝘀𝗶 𝗢𝗿𝗱𝗲𝗿", callback_data: "pay_reseller_panel" }],
          [{ text: "❌ 𝗕𝗮𝘁𝗮𝗹 𝗢𝗿𝗱𝗲𝗿", callback_data: "shop_menu" }]
        ]
      }
    }
  );
});

bot.action("pay_reseller_panel", async (ctx) => {
  if (!await requirePrivateChat(ctx, 'pay_reseller_panel')) return;

  const harga = config.hargaResellerPanel || 25000;

  try { await ctx.deleteMessage(); } catch (e) {}

  await handlePayment(ctx, harga, "Akses Reseller Panel", {
    type: "reseller_panel",
    price: harga
  });
});

bot.action("buy_admin_panel", async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buy_admin_panel')) return;

  userState[ctx.from.id] = { step: "WAITING_USERNAME_ADMIN_PANEL" };

  await editMenuMessage(ctx,
    `<b>🛠️ 𝗕𝗘𝗟𝗜 𝗔𝗗𝗠𝗜𝗡 𝗣𝗔𝗡𝗘𝗟</b>\n\n` +
    `Harga: <b>${toRupiah(config.hargaAdminPanel)}</b>\n` +
    `Benefit: Akun Root Admin (Full Akses)\n\n` +
    `<i>Silahkan Kirim Username Untuk Akun Admin Kamu (Min 5 Huruf)...</i>`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "❌ 𝗕𝗮𝘁𝗮𝗹 𝗢𝗿𝗱𝗲𝗿", callback_data: "shop_menu" }]
        ]
      }
    }
  );
});

bot.action(/pay_panel_(\d+)_(\d+)_(.+)/, async (ctx) => {
  if (!await requirePrivateChat(ctx, 'pay_panel')) return;
  
  const ram = parseInt(ctx.match[1]);
  const price = parseInt(ctx.match[2]);
  const username = ctx.match[3];

  await handlePayment(ctx, price, `Panel ${ram === 0 ? "Unlimited" : ram/1024 + "GB"}`, {
    type: "panel",
    username: username,
    ram: ram,
    price: price
  });
});

bot.on('audio', async (ctx) => {
  console.log('Audio File ID:', ctx.message.audio.file_id);
  console.log('Audio Metadata:', {
    title: ctx.message.audio.title,
    performer: ctx.message.audio.performer,
    duration: ctx.message.audio.duration
  });
});

bot.on("text", async (ctx, next) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  if (["📁 ☇ 𝗦𝗰𝗿𝗶𝗽𝘁", "📱 ☇ 𝗔𝗽𝗽𝘀", "📡 ☇ 𝗣𝗮𝗻𝗲𝗹", "🛠 ☇ 𝗧𝗼𝗼𝗹𝘀", "🌸 ☇ 𝗢𝘄𝗻𝗲𝗿"].includes(text)) {
    return next();
  }
  if (userState[userId]?.step === "WAITING_USERNAME_ADMIN_PANEL") {
    if (ctx.chat.type !== 'private') return next();

    if (!/^[a-zA-Z0-9]+$/.test(text)) {
        return ctx.reply("<blockquote>⚠️ <b>Username hanya boleh huruf & angka!</b></blockquote>", { 
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "❌ Batalkan", callback_data: "shop_menu" }]] }
        });
    }

    const username = text;
    delete userState[userId].step;
    
    const harga = config.hargaAdminPanel;

    await handlePayment(ctx, harga, `Admin Panel (${username})`, {
        type: "admin_panel",
        username: username,
        price: harga
    });
    return;
  }

  if (userState[userId]?.step === "SMM_WAITING_LINK") {
    if (ctx.chat.type !== 'private') return next();

    const link = text;
    userState[userId].link = link;
    userState[userId].step = "SMM_WAITING_QTY";
    
    return ctx.reply("🔢 <b>𝗠𝗔𝗦𝗨𝗞𝗔𝗡 𝗝𝗨𝗠𝗟𝗔𝗛 :</b>\n\n└⌑ 𝖤𝗑𝖺𝗆𝗉𝗅𝖾 : 𝟣𝟢𝟢𝟢", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[Markup.button.callback('❌ 𝗕𝗮𝘁𝗮𝗹𝗸𝗮𝗻', 'smm_menu')]] }
    });
  }

  if (userState[userId]?.step === "SMM_WAITING_QTY" && ctx.chat.type === 'private') {
    const qty = parseInt(text);

    if (isNaN(qty) || qty <= 0) {
        return ctx.reply("❌ <b>𝗛𝗮𝗿𝘂𝘀 𝗕𝗲𝗿𝘂𝗽𝗮 𝗔𝗻𝗴𝗸𝗮</b>\n\n└⌑ 𝖲𝗂𝗅𝖺𝗁𝗄𝖺𝗇 𝖬𝖺𝗌𝗎𝗄𝖺𝗇 𝖩𝗎𝗆𝗅𝖺𝗁 𝖸𝖺𝗇𝗀 𝖵𝖺𝗅𝗂𝖽 (𝖤𝗑𝖺𝗆𝗉𝗅𝖾: 𝟣𝟢𝟢𝟢).", {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "❌ Batalkan", callback_data: "smm_menu" }]] }
        });
    }

    const state = userState[userId];
    
    const res = await callSmmApi('/services');
    let services = res.services || res.data || [];
    const service = services.find(s => s.id == state.serviceId);
    
    if (!service) {
        delete userState[userId];
        return ctx.reply("❌ 𝗟𝗮𝘆𝗮𝗻𝗮𝗻 𝗧𝗶𝗱𝗮𝗸 𝗗𝗶𝘁𝗲𝗺𝘂𝗸𝗮𝗻/𝗕𝗲𝗿𝘂𝗯𝗮𝗵.");
    }

    if (qty < service.min || qty > service.max) {
        return ctx.reply(`❌ <b>𝗝𝘂𝗺𝗹𝗮𝗵 𝗧𝗶𝗱𝗮𝗸 𝗦𝗲𝘀𝘂𝗮𝗶</b>\n├⌑𝖬𝗂𝗇 : ${service.min}\n└⌑ 𝖬𝖺𝗑 : ${service.max}`, { parse_mode: "HTML" });
    }

    const totalPrice = (parseFloat(service.price) / 1000) * qty;
    
    const dbSaldoPath = "./database/saldoOtp.json";
    const saldoData = JSON.parse(fs.readFileSync(dbSaldoPath, "utf8") || "{}");
    const userSaldo = saldoData[userId] || 0;

    if (userSaldo < totalPrice) {
        delete userState[userId];
        return ctx.reply(`<blockquote>❌ <b>𝗦𝗔𝗟𝗗𝗢 𝗧𝗜𝗗𝗔𝗞 𝗖𝗨𝗞𝗨𝗣!</b>\n\n╭⌑ 💰 𝖡𝗎𝗍𝗎𝗁 : ${toRupiah(totalPrice)}\n├⌑ 💳 𝖲𝖺𝗅𝖽𝗈 𝖪𝖺𝗆𝗎 : ${toRupiah(userSaldo)}\n\n╰⌑ 🍂 𝖲𝗂𝗅𝖺𝗁𝗄𝖺𝗇 𝖣𝖾𝗉𝗈𝗌𝗂𝗍 𝖳𝖾𝗅𝖾𝖻𝗂𝗁 𝖣𝖺𝗁𝗎𝗅𝗎.</blockquote>`, { 
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[Markup.button.callback('➕ 𝗜𝘀𝗶 𝗦𝗮𝗹𝗱𝗼', 'topup_nokos')]] }
        });
    }

    userState[userId].pendingOrder = {
        serviceId: state.serviceId,
        serviceName: service.name,
        target: state.link,
        quantity: qty,
        price: totalPrice
    };

    await ctx.reply(
        `🚀 <b>𝗞𝗢𝗡𝗙𝗜𝗥𝗠𝗔𝗦𝗜 𝗣𝗘𝗦𝗔𝗡𝗔𝗡</b>\n\n` +
        `├⌑ 📦 <b>𝖫𝖺𝗒𝖺𝗇𝖺𝗇 :</b> ${service.name}\n` +
        `├⌑ 🔗 <b>𝖳𝖺𝗋𝗀𝖾𝗍 :</b> ${state.link}\n` +
        `├⌑ 🔢 <b>𝖩𝗎𝗆𝗅𝖺𝗁 :</b> ${qty}\n` +
        `└⌑ 💰 <b>𝖳𝗈𝗍𝖺𝗅 𝖧𝖺𝗋𝗀𝖺 :</b> ${toRupiah(totalPrice)}\n\n` +
        `<i>📝 𝖭𝗈𝗍𝖾 : 𝖲𝗂𝗅𝖺𝗁𝗄𝖺𝗇 𝖯𝖺𝗌𝗍𝗂𝗄𝖺𝗇 𝖯𝖾𝗌𝖺𝗇𝖺𝗇 𝖡𝖾𝗇𝖺𝗋 𝖲𝖾𝖻𝖾𝗅𝗎𝗆 𝖫𝖺𝗇𝗃𝗎𝗍!</i>`,
        {
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "✅ 𝗞𝗼𝗻𝗳𝗶𝗿𝗺𝗮𝘀𝗶 𝗢𝗿𝗱𝗲𝗿", callback_data: "smm_exec_order" }],
                    [{ text: "❌ 𝗕𝗮𝘁𝗮𝗹𝗸𝗮𝗻", callback_data: "smm_menu" }]
                ]
            }
        }
    );
    return;
  }

  if (userState[userId]?.step === "SMM_WAITING_STATUS_ID") {
      if (ctx.chat.type !== 'private') return next();

      const orderId = text;
      const res = await callSmmApi('/status', { id: orderId });
      
      if (res.status === true) {
          ctx.reply(`📊 <b>𝗦𝗧𝗔𝗧𝗨𝗦 𝗢𝗥𝗗𝗘𝗥 #${orderId}</b>\n├⌑ 𝖲𝗍𝖺𝗍𝗎𝗌 :<b>${res.data?.status || res.order_status}</b>\n├⌑ 𝖲𝗍𝖺𝗋𝗍 : ${res.data?.start_count || '-'}\n└⌑ 𝖲𝗂𝗌𝖺 : ${res.data?.remains || '-'}`, { parse_mode: "HTML" });
      } else {
          ctx.reply("❌ 𝗗𝗮𝘁𝗮 𝗧𝗶𝗱𝗮𝗸 𝗗𝗶𝘁𝗲𝗺𝘂𝗸𝗮𝗻/𝗘𝗿𝗿𝗼𝗿.", { parse_mode: "HTML" });
      }
      delete userState[userId];
      return;
  }
  
  if (userState[userId]?.step === "WAITING_TOPUP_RUMAHOTP") {
    if (ctx.chat.type !== 'private') return next();

    const amount = parseInt(text);
    
    if (isNaN(amount) || amount < 2000) {
       return safeReply(ctx, "❌ <b>Minimal deposit Rp 2.000 dan harus angka!</b>", {
           parse_mode: "HTML",
           reply_markup: { inline_keyboard: [[{ text: "❌ 𝗕𝗮𝘁𝗮𝗹𝗸𝗮𝗻", callback_data: "shop_menu" }]] }
       });
    }
    
    delete userState[userId];

    const loading = await safeReply(ctx, "🔄 <b>𝗠𝗘𝗠𝗕𝗨𝗔𝗧 𝗤𝗥𝗜𝗦...</b>", { parse_mode: "HTML" });
    const apiKey = config.RUMAHOTP;
    const fee = config.UNTUNG_DEPOSIT || 500;
    const totalRequest = amount + fee;

        try {
       const res = await axios.get(`https://www.rumahotp.com/api/v2/deposit/create?amount=${totalRequest}&payment_id=qris`, {
          headers: { "x-apikey": apiKey }
       });
       
       await ctx.deleteMessage(loading.message_id).catch(()=>{});

       if (!res.data.success) {
          return safeReply(ctx, "❌ Gagal membuat QRIS. Coba lagi nanti.", {
              reply_markup: { inline_keyboard: [[{ text: "🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", callback_data: "shop_menu" }]] }
          });
       }

       const d = res.data.data;
       const caption = `<b>💳 TAGIHAN DEPOSIT</b>\n\n🆔 ID: <code>${d.id}</code>\n💰 Total Bayar: <b>${toRupiah(d.total)}</b>\n(Termasuk biaya admin)\n\n📥 Masuk Saldo: ${toRupiah(amount)}\n\n⚠️ <b>Bayar sesuai nominal TOTAL (sampai digit terakhir)!</b>\nOtomatis cek status...`;
       
       const msgQris = await ctx.replyWithPhoto(d.qr_image, {
          caption: caption,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{text: "❌ 𝗕𝗮𝘁𝗮𝗹𝗸𝗮𝗻", callback_data: `batal_depo_rumahotp_${d.id}`}]] }
       });

       let checks = 0;
       const maxChecks = 120;
       const checkInterval = setInterval(async () => {
          checks++;
          if (checks > maxChecks) {
             clearInterval(checkInterval);
             return;
          }

          try {
             const checkRes = await axios.get(`https://www.rumahotp.com/api/v2/deposit/get_status?deposit_id=${d.id}`, { headers: { "x-apikey": apiKey } });
             
             if (checkRes.data && checkRes.data.success) {
                 const status = checkRes.data.data.status;

                 if (status === 'success' || status === 'paid') {
                     clearInterval(checkInterval);
                     
                     const dbPath = "./database/saldoOtp.json";
                     let saldoDB = {};
                     try { saldoDB = JSON.parse(fs.readFileSync(dbPath, "utf8")); } catch(e){}
                     
                     saldoDB[userId] = (saldoDB[userId] || 0) + amount;
                     fs.writeFileSync(dbPath, JSON.stringify(saldoDB, null, 2));

                     await ctx.deleteMessage(msgQris.message_id).catch(()=>{});
                     await ctx.reply(`✅ <b>DEPOSIT SUKSES!</b>\n\n💰 Diterima: ${toRupiah(amount)}\n💼 Total Saldo: ${toRupiah(saldoDB[userId])}`, { parse_mode: "HTML" });
                     
                     bot.telegram.sendMessage(config.ownerId, `🔔 User ${userId} Deposit ${amount}`).catch(()=>{});

                 } else if (status === 'cancelled' || status === 'failed') {
                     clearInterval(checkInterval);
                     await ctx.deleteMessage(msgQris.message_id).catch(()=>{});
                     await ctx.reply("❌ Deposit dibatalkan/gagal.");
                 }
             }
          } catch(e) { 
              console.log("Error cek deposit:", e.message);
          }
       }, 5000);

    } catch(e) {
       console.error(e);
       safeReply(ctx, "❌ Error API RumahOTP");
    }
    return;
  }
  
  if (userState[userId]?.step === "WAITING_USERNAME_PANEL") {
    if (ctx.chat.type !== 'private') return next();

    if (!/^[a-zA-Z0-9]+$/.test(text)) {
        return ctx.reply("<blockquote>⚠️ <b>Username hanya boleh huruf & angka!</b></blockquote>", { 
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "❌ Batalkan", callback_data: "back_home" }]] }
        });
    }

    const username = text;
    delete userState[userId].step;

    const hargaGb = config.hargaPanel.perGB;
    const hargaUnli = config.hargaPanel.unlimited;

    let listRam = [];

    for (let gb = 1; gb <= 10; gb++) {
        const ramMB = gb * 1024;
        const price = gb * hargaGb;

        listRam.push({
            label: `${gb}GB - ${toRupiah(price)}`,
            ram: ramMB,
            price
        });
    }

    listRam.push({
        label: `UNLIMITED (${toRupiah(hargaUnli)})`,
        ram: 0,
        price: hargaUnli
    });

    const buttons = listRam.map(p => {
        return [{ text: p.label, callback_data: `pay_panel_${p.ram}_${p.price}_${username}` }];
    });

    buttons.push([{ text: "🔙 𝗕𝗮𝘁𝗮𝗹", callback_data: "back_home" }]);

    return ctx.reply(
        `<blockquote><b>📡 𝗣𝗶𝗹𝗶𝗵 𝗦𝗽𝗲𝘀𝗶𝗳𝗶𝗸𝗮𝘀𝗶 𝗨𝗻𝘁𝘂𝗸 𝗣𝗮𝗻𝗲𝗹 ${username}</b></blockquote>`,
        {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buttons }
        }
    );
  }

  if (userState[userId]?.step === "WAITING_SCRIPT_DETAIL") {
    if (ctx.chat.type !== 'private') return next();

    const state = userState[userId];
    const parts = text.split("|").map(x => x.trim());
    
    if (parts.length !== 3) {
        return safeReply(ctx, "<blockquote>❌ Format detail salah! Gunakan: Nama | Harga (angka) | Deskripsi</blockquote>", { 
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "❌ Batalkan", callback_data: "menu_owner" }]] }
        });
    }
    
    const [nama, hargaStr, deskripsi] = parts;
    const harga = parseInt(hargaStr);
    
    if (isNaN(harga) || harga <= 0) {
        return safeReply(ctx, "<blockquote>❌ Harga harus angka positif!</blockquote>", { 
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "❌ Batalkan", callback_data: "menu_owner" }]] }
        });
    }
    
    try {
        const db = readDb();
        const scriptData = {
        nama: nama,
        harga: harga,
        deskripsi: deskripsi,
        file_id: state.file_id, 
        fileName: state.temp_fileName 
        };
        
        db.scripts.push(scriptData);
        saveDb(db);
        
        const addedBy = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
        
        
        safeReply(ctx, `<blockquote><b>✅ Sukses Menambah Script!</b>\n\n<b>📂 Nama:</b> <code>${nama}</code>\n<b>💰 Harga:</b> <code>${toRupiah(harga)}</code>\n<b>📄 File:</b> <code>${state.temp_fileName}</code>\n\n</blockquote>`, { 
        parse_mode: "HTML" 
        });
        
    } catch (e) {
        console.error(e);
        safeReply(ctx, "❌ Gagal menyimpan data script ke database.");
    }
    
    delete userState[userId];
    return;
  }

  if (userState[userId]?.step === "WAITING_APP_TEXT") {
    if (userId !== config.ownerId) return next();
    if (ctx.chat.type !== 'private') return next();
    
    const parts = text.split("|").map(x => x.trim());
    
    if (parts.length !== 3) {
        return safeReply(ctx, "<blockquote>❌ Format salah! Gunakan: Nama | Harga | Deskripsi</blockquote>", { 
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "❌ Batalkan", callback_data: "menu_owner" }]] }
        });
    }
    
    const [nama, hargaStr, deskripsi] = parts;
    const harga = parseInt(hargaStr);
    
    if (isNaN(harga) || harga <= 0) {
        return safeReply(ctx, "<blockquote>❌ Harga harus angka positif!</blockquote>", { 
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "❌ Batalkan", callback_data: "menu_owner" }]] }
        });
    }
    
    try {
        const db = readDb();
        const newApp = {
        nama,
        harga,
        deskripsi,
        accounts: [] 
        };
        
        db.apps.push(newApp);
        saveDb(db);
        const idx = db.apps.length - 1;
        
        const addedBy = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
        
        
        await safeReply(ctx, `<blockquote><b>✅ App Premium ditambahkan!</b>\n<b>📱 ${nama}</b>\n<b>Stock:</b> 0\n\n</blockquote>`, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
            [ Markup.button.callback("📄 List Account", `list_accounts_${idx}`) ],
            [ Markup.button.callback("🔙 Kembali ke Owner Menu", "menu_owner") ]
        ])
        });
        
    } catch (e) {
        console.error(e);
        safeReply(ctx, "❌ Gagal menyimpan data app ke database.");
    }
    
    delete userState[userId];
    return;
  }

  if (userState[userId]?.step === "WAITING_ADD_ACCOUNT") {
    if (userId !== config.ownerId) return next();
    if (ctx.chat.type !== 'private') return next();
    
    const st = userState[userId];
    const parts = text.split("|").map(x => x.trim());
    
    if (parts.length !== 4) {
        return safeReply(ctx, "<blockquote>❌ Format salah! Gunakan: username|password|link akses|deskripsi</blockquote>", { 
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "❌ Batalkan", callback_data: "menu_owner" }]] }
        });
    }
    
    const [usernameA, passwordA, linkA, descA] = parts;
    
    try {
        const db = readDb();
        const app = db.apps[st.appIndex];
        
        if (!app) {
        return safeReply(ctx, "❌ App tidak ditemukan / sudah dihapus.");
        }
        
        app.accounts = app.accounts || [];
        app.accounts.push({ 
        user: usernameA, 
        pass: passwordA, 
        link: linkA, 
        desc: descA 
        });
        
        saveDb(db);
        const stockNow = app.accounts.length;
        
        const addedBy = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
        const accountData = {
        appName: app.nama,
        username: usernameA,
        password: passwordA,
        link: linkA,
        desc: descA,
        newStock: stockNow
        };
        
        
        safeReply(ctx, `<blockquote><b>✅ Akun ditambahkan!</b>\n<b>Stock sekarang:</b> ${stockNow}\n\n</blockquote>`, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
            [ Markup.button.callback("➕ Tambah lagi", `owner_add_account`) ],
            [ Markup.button.callback("📃 List App Premium", "list_apps") ],
            [ Markup.button.callback("🔙 Kembali ke Owner Menu", "menu_owner") ]
        ])
        });
        
    } catch (e) {
        console.error(e);
        safeReply(ctx, "❌ Gagal menambahkan akun ke database.");
    }
    
    delete userState[userId];
    return;
  }

  if (userState[ctx.from.id]?.step === "WAITING_BROADCAST" && ctx.from.id === config.ownerId) {
    if (ctx.chat.type !== 'private') return next();

    const users = loadUsers();
    let sent = 0;
    for (const uid of users) {
      try {
        if (ctx.message.photo) {
          await bot.telegram.sendPhoto(uid, ctx.message.photo[0].file_id, { caption: ctx.message.caption || "", parse_mode: "HTML" });
        } else if (ctx.message.document) {
          await bot.telegram.sendDocument(uid, ctx.message.document.file_id, { caption: ctx.message.caption || "", parse_mode: "HTML" });
        } else {
          await bot.telegram.sendMessage(uid, ctx.message.text);
        }
        sent++;
      } catch (e) {}
    }
    delete userState[ctx.from.id];
    return safeReply(ctx, `<blockquote>📢 <b>Broadcast selesai!</b> <b>Terkirim:</b> ${sent}</blockquote>`, { parse_mode: "HTML" });
  }

  return next();
});

async function handlePayment(ctx, nominal, itemName, productData) {
  if (!isPrivateChat(ctx)) {
    await ctx.answerCbQuery?.();
    return safeReply(ctx, "❌ <b>Pembayaran hanya bisa dilakukan di Private Chat!</b>\n\n💬 Silakan chat saya di private: https://t.me/" + bot.botInfo.username, { parse_mode: "HTML" });
  }
  
  const userId = ctx.from.id;
  if (activeTransactions[userId]) return safeReply(ctx, "<blockquote>⚠️ <b>Ada transaksi pending.</b> Ketik /cancel.</blockquote>", { parse_mode: "HTML" });
  
  const activePaymentMethod = getActivePaymentMethod();
  
  if (activePaymentMethod === "manual") {
    if (!config.manualQrisPhoto) {
      return safeReply(ctx, "<blockquote>❌ <b>QRIS manual belum diatur oleh owner.</b> Silakan hubungi owner.</blockquote>", { parse_mode: "HTML" });
    }
    
    const fee = Math.floor(Math.random() * 100);
    const totalBayar = nominal + fee;
    
    await ctx.replyWithPhoto(config.manualQrisPhoto, {
      caption: `<blockquote><b>🧾 TAGIHAN MANUAL</b>\n\n<b>Item:</b> <code>${itemName}</code>\n<b>Total:</b> ${toRupiah(totalBayar)}\n\n<i>Silakan transfer sesuai nominal di atas</i>\n<i>Lalu kirim foto bukti transfer ke bot ini</i>\n<i>Bot akan otomatis mengirim ke owner</i></blockquote>`,
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("❌ Batalkan", "cancel_trx")]
      ])
    });
    
    userState[userId] = {
      step: "PAYMENT_MANUAL_PENDING",
      itemName: itemName,
      amount: totalBayar,
      productData: productData,
      nominal: nominal
    };
    
    return;
  }
  
  const fee = Math.floor(Math.random() * 100);
  const totalBayar = nominal + fee;
  const msgLoading = await safeReply(ctx, "<blockquote>🔄 <b>Membuat QRIS...</b></blockquote>", { parse_mode: "HTML" });
  
  let paymentConfig = {};
  if (activePaymentMethod === "atlantic") {
    paymentConfig = { 
      method: "atlantic", 
      apiAtlantic: config.payment?.apiAtlantic || config.apikeyAtlantic || config.ApikeyAtlantic || config.apiAtlantic 
    };
  } else {
    paymentConfig = Object.assign({ method: "orkut" }, config.payment || {});
  }
  
  const qrisData = await createdQris(totalBayar, paymentConfig);
  
  try {
    await ctx.deleteMessage(msgLoading.message_id);
  } catch (e) {}
  
  if (!qrisData) {
    return safeReply(ctx, "<blockquote>❌ <b>Gagal membuat QRIS.</b></blockquote>", { parse_mode: "HTML" });
  }
  
  console.log("[DEBUG] QRIS Data:", {
    hasImage: !!qrisData.imageqris,
    imageType: typeof qrisData.imageqris,
    isBuffer: qrisData.imageqris instanceof Buffer,
    isString: typeof qrisData.imageqris === 'string',
    hasQrString: !!qrisData.qr_string,
    fullData: qrisData
  });
  
  let photoToSend = null;
  let useLocalQR = false;
  
  if (qrisData.imageqris instanceof Buffer) {
    console.log("[DEBUG] QRIS adalah Buffer, size:", qrisData.imageqris.length);
    photoToSend = { source: qrisData.imageqris };
    
  } else if (qrisData.imageqris && typeof qrisData.imageqris === 'string') {
    if (qrisData.imageqris.startsWith('data:image')) {
      try {
        console.log("[DEBUG] QRIS adalah Base64");
        const base64Data = qrisData.imageqris.replace(/^data:image\/\w+;base64,/, '');
        photoToSend = { source: Buffer.from(base64Data, 'base64') };
      } catch (e) {
        console.error("[ERROR] Failed to parse base64 image:", e.message);
      }
      
    } else if (qrisData.imageqris.startsWith('http')) {
      console.log("[DEBUG] QRIS adalah URL:", qrisData.imageqris);
      
      try {
        const { downloadQrisImage } = require("./lib/payment");
        const qrBuffer = await downloadQrisImage(qrisData.imageqris);
        
        if (qrBuffer) {
          console.log("[DEBUG] QRIS downloaded successfully, size:", qrBuffer.length);
          photoToSend = { source: qrBuffer };
        } else {
          console.log("[DEBUG] Failed to download QRIS, will use qr_string");
          useLocalQR = true;
        }
      } catch (downloadErr) {
        console.error("[ERROR] Failed to download QRIS image:", downloadErr.message);
        useLocalQR = true;
      }
    } else {
      console.log("[DEBUG] QRIS adalah string biasa");
      useLocalQR = true;
    }
  }
  
  if (!photoToSend && (useLocalQR || !qrisData.imageqris)) {
    if (qrisData.qr_string && qrisData.qr_string.trim().length > 0) {
      console.log("[DEBUG] Generating local QR from qr_string");
      try {
        const qrBuffer = await generateLocalQr(qrisData.qr_string);
        if (qrBuffer) {
          photoToSend = { source: qrBuffer };
          console.log("[DEBUG] Local QR generated successfully");
        } else {
          console.log("[DEBUG] Failed to generate local QR");
        }
      } catch (qrErr) {
        console.error("[ERROR] Failed to generate local QR:", qrErr.message);
      }
    }
  }
  
  if (!photoToSend) {
    console.error("[ERROR] No valid QRIS data available");
    return safeReply(ctx, 
      `<b>❌ GAGAL MEMBUAT QRIS</b>\n\n` +
      `<b>Item:</b> ${itemName}\n` +
      `<b>Total:</b> ${toRupiah(totalBayar)}\n\n` +
      `<i>Silakan hubungi owner untuk pembayaran manual.</i>`,
      { parse_mode: "HTML" }
    );
  }
  
  try {
    console.log("[DEBUG] Sending QRIS to user");
    
    const msgQris = await ctx.replyWithPhoto(photoToSend, {
      caption: `<blockquote><b>🧾 TAGIHAN</b>\n\n<b>Item:</b> <code>${itemName}</code>\n<b>Total:</b> ${toRupiah(qrisData.jumlah)}\n\n<i>Bayar pas sesuai nominal!</i>\n<i>Transaksi akan otomatis terverifikasi setelah pembayaran.</i></blockquote>`,
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("❌ Batalkan", "cancel_trx")]
      ])
    });
    
    activeTransactions[userId] = { 
      id: qrisData.idtransaksi || qrisData.id, 
      amount: qrisData.jumlah, 
      status: 'pending',
      messageId: msgQris.message_id,
      paymentMethod: activePaymentMethod,
      paymentConfig: paymentConfig
    };
    
    console.log(`[DEBUG] Transaction started for user ${userId}:`, activeTransactions[userId].id);
    
    let attempts = 0;
    const maxAttempts = 72;
    
    const interval = setInterval(async () => {
      attempts++;
      
      if (!activeTransactions[userId]) {
        console.log(`[DEBUG] Transaction ${userId} cancelled, stopping check`);
        clearInterval(interval);
        return;
      }
      
      if (attempts > maxAttempts) {
        console.log(`[DEBUG] Payment timeout for user ${userId} after ${attempts} attempts`);
        clearInterval(interval);
        
        if (activeTransactions[userId]) {
          try {
            if (activeTransactions[userId].messageId) {
              await ctx.deleteMessage(activeTransactions[userId].messageId).catch(() => {});
            }
          } catch (e) {}
          
          delete activeTransactions[userId];
          await safeReply(ctx, "<blockquote>❌ <b>Waktu pembayaran habis.</b> Silakan ulangi transaksi.</blockquote>", { 
            parse_mode: "HTML" 
          });
        }
        return;
      }
      
      try {
        console.log(`[DEBUG] Checking payment status for user ${userId}, attempt ${attempts}`);
        
        const isPaid = await cekStatus(
          qrisData.idtransaksi || qrisData.id, 
          qrisData.jumlah, 
          paymentConfig
        );
        
        if (isPaid) {
          console.log(`[DEBUG] Payment confirmed for user ${userId}`);
          clearInterval(interval);
          
          try {
            if (activeTransactions[userId]?.messageId) {
              await ctx.deleteMessage(activeTransactions[userId].messageId).catch(() => {});
            }
          } catch (e) {}
          
          delete activeTransactions[userId];
          
          const userName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim();
          sendTestimoniKeChannel(userName, userId, itemName, nominal);
          
          try {
            await bot.telegram.sendMessage(
              config.ownerId,
              `<b>💰 PEMBAYARAN SUKSES</b>\n\n` +
              `<b>👤 User:</b> ${ctx.from.first_name} (${ctx.from.id})\n` +
              `<b>🛒 Item:</b> ${itemName}\n` +
              `<b>💵 Harga:</b> ${toRupiah(nominal)}\n` +
              `<b>📊 Status:</b> QRIS Payment (${activePaymentMethod.toUpperCase()})\n` +
              `<b>⏰ Waktu:</b> ${new Date().toLocaleString()}`,
              { parse_mode: "HTML" }
            );
          } catch (ownerErr) {
            console.error("[ERROR] Failed to notify owner:", ownerErr.message);
          }
          
          await sendProductToUser(ctx, productData);
        } else {
          console.log(`[DEBUG] Payment not yet confirmed for user ${userId}`);
        }
        
      } catch (error) {
        console.error(`[ERROR] Error checking payment status for user ${userId}:`, error.message);
        
        if (attempts > 10) {
          clearInterval(interval);
          console.error(`[ERROR] Too many errors, stopping check for user ${userId}`);
          
          if (activeTransactions[userId]) {
            delete activeTransactions[userId];
            await safeReply(ctx, "<blockquote>⚠️ <b>Terjadi gangguan sistem pembayaran.</b> Silakan hubungi owner.</blockquote>", { 
              parse_mode: "HTML" 
            });
          }
        }
      }
    }, 5000);
    
  } catch (error) {
    console.error("[ERROR] Failed to send QRIS photo:", error.message);
    
    if (activeTransactions[userId]) {
      delete activeTransactions[userId];
    }
    
    let errorMessage = `<b>⚠️ GAGAL MENAMPILKAN QRIS</b>\n\n`;
    errorMessage += `<b>Item:</b> ${itemName}\n`;
    errorMessage += `<b>Total:</b> ${toRupiah(qrisData.jumlah)}\n`;
    errorMessage += `<b>ID Transaksi:</b> ${qrisData.idtransaksi || qrisData.id || '-'}\n`;
    
    if (qrisData.qr_string && qrisData.qr_string.length < 500) {
      errorMessage += `<b>QR String:</b>\n<code>${qrisData.qr_string}</code>\n\n`;
    }
    
    errorMessage += `<i>Silakan hubungi owner untuk pembayaran manual.</i>`;
    
    await safeReply(ctx, errorMessage, { parse_mode: "HTML" });
  }
}

bot.action(/delete_sc_(\d+)/, async (ctx) => {
  try {
    const idx = parseInt(ctx.match[1]);
    const db = readDb();
    const sc = db.scripts[idx];

    if (!sc) {
      await ctx.answerCbQuery("❌ Script tidak ditemukan.");
      return;
    }

    db.scripts.splice(idx, 1);
    saveDb(db);

    await ctx.answerCbQuery("✅ Script berhasil dihapus!");
    await ctx.editMessageText("✔️ Script berhasil dihapus.", Markup.inlineKeyboard([[Markup.button.callback("🔙 Kembali", "menu_owner")]]))
      .catch(()=>{ safeReply(ctx, "✔️ Script berhasil dihapus."); });

  } catch (e) {
    console.error("delete_sc error:", e);
  }
});

bot.action(/delete_app_(\d+)/, (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  const idx = parseInt(ctx.match[1]);
  const db = readDb();
  const app = db.apps[idx];
  if (!app) {
    ctx.answerCbQuery("❌ App tidak ditemukan.");
    return showOwnerMenu(ctx);
  }
  db.apps.splice(idx, 1);
  saveDb(db);
  ctx.answerCbQuery(`✅ App ${app?.nama || 'Item'} berhasil dihapus.`);
  showOwnerMenu(ctx);
});

bot.action(/list_accounts_(\d+)/, (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  const idx = parseInt(ctx.match[1]);
  const db = readDb();
  const app = db.apps[idx];
  if (!app) return ctx.answerCbQuery("❌ App tidak ditemukan.");
  const accounts = app.accounts || [];
  let txt = `<b>📄 List Accounts - ${app.nama}</b>\n<b>Stock:</b> ${accounts.length}\n\n`;
  if (!accounts.length) txt += "<i>Belum ada akun.</i>\n";
  accounts.forEach((a, i) => {
    txt += `<b>${i+1}.</b> ${a.user} | ${a.pass} | ${a.link} | ${a.desc || '-'}\n`;
  });
  safeReply(ctx, txt, { parse_mode: "HTML" });
  ctx.answerCbQuery().catch(()=>{});
});

bot.action("owner_add_account", (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  const db = readDb();
  if (!db.apps || db.apps.length === 0) return safeReply(ctx, "<blockquote>❌ <b>Belum ada app yang terdaftar.</b> Tambahkan app terlebih dahulu.</blockquote>", { parse_mode: "HTML" });
  const buttons = db.apps.map((a, i) => [ Markup.button.callback(`${a.nama} (${(a.accounts||[]).length} stok)`, `owner_add_account_to_${i}`) ]);
  buttons.push([ Markup.button.callback("🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", "menu_owner") ]);
  safeReply(ctx, "<blockquote><b>Pilih aplikasi untuk menambah akun:</b></blockquote>", { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
  ctx.answerCbQuery().catch(()=>{});
});

bot.action(/owner_add_account_to_(\d+)/, (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  const idx = parseInt(ctx.match[1]);
  const db = readDb();
  if (!db.apps[idx]) return ctx.answerCbQuery("❌ App tidak ditemukan.");
  userState[ctx.from.id] = { step: "WAITING_ADD_ACCOUNT", appIndex: idx };
  safeReply(ctx, "<blockquote><b>✏️ Kirim akun dengan format:</b>\n<code>username|password|link akses|deskripsi</code></blockquote>", { parse_mode: "HTML" });
  ctx.answerCbQuery().catch(()=>{});
});

bot.action("owner_del_account", (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  const db = readDb();
  if (!db.apps || db.apps.length === 0) return safeReply(ctx, "<blockquote>❌ <b>Belum ada app yang terdaftar.</b></blockquote>", { parse_mode: "HTML" });
  const buttons = db.apps.map((a, i) => [ Markup.button.callback(`${a.nama} (${(a.accounts||[]).length} stok)`, `owner_del_account_choose_${i}`) ]);
  buttons.push([ Markup.button.callback("🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", "menu_owner") ]);
  safeReply(ctx, "<blockquote><b>Pilih aplikasi untuk menghapus akun:</b></blockquote>", { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
  ctx.answerCbQuery().catch(()=>{});
});

bot.action(/owner_del_account_choose_(\d+)/, (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  const idx = parseInt(ctx.match[1]);
  const db = readDb();
  const app = db.apps[idx];
  if (!app) return ctx.answerCbQuery("❌ App tidak ditemukan.");
  const accounts = app.accounts || [];
  if (!accounts.length) return safeReply(ctx, "<blockquote>❌ <b>Tidak ada akun pada aplikasi ini.</b></blockquote>", { parse_mode: "HTML" });
  const buttons = accounts.map((acc, i) => [ Markup.button.callback(`🗑 ${i+1}. ${acc.user} - ${acc.desc || '-'}`, `owner_delete_acc_${idx}_${i}`) ]);
  buttons.push([ Markup.button.callback("🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", "menu_owner") ]);
  safeReply(ctx, `<blockquote><b>Pilih akun yang ingin dihapus dari ${app.nama}:</b></blockquote>`, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
  ctx.answerCbQuery().catch(()=>{});
});

bot.action(/owner_delete_acc_(\d+)_(\d+)/, (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  const appIndex = parseInt(ctx.match[1]);
  const accIndex = parseInt(ctx.match[2]);
  const db = readDb();
  const app = db.apps[appIndex];
  if (!app) return ctx.answerCbQuery("❌ App tidak ditemukan.");
  if (!app.accounts || !app.accounts[accIndex]) return ctx.answerCbQuery("❌ Akun tidak ditemukan.");
  const removed = app.accounts.splice(accIndex, 1);
  saveDb(db);
  ctx.answerCbQuery("✅ Akun dihapus.");
  safeReply(ctx, `<blockquote><b>✅ Akun ${removed[0].user} telah dihapus dari ${app.nama}</b></blockquote>`, { parse_mode: "HTML" });
});

async function sendProductToUser(ctx, productData) {
  try {
    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name;
    const userNameFull = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim();

    if (productData.type === "script") {
      const db = readDb();
      const item = db.scripts[productData.index];
      
      if (!item) {
        return safeReply(ctx, "<blockquote>❌ <b>Script tidak ditemukan!</b> Silakan hubungi owner.</blockquote>", { parse_mode: "HTML" });
      }
      
      if (!item.file_id) {
        return safeReply(ctx, "<blockquote>❌ <b>File script tidak tersedia!</b> Silakan hubungi owner.</blockquote>", { parse_mode: "HTML" });
      }
      
      await safeReply(ctx, "<blockquote>✅ <b>Pembayaran valid! Mengirim file...</b></blockquote>", { parse_mode: "HTML" });
      
      await ctx.replyWithDocument(item.file_id, { 
        caption: `<b>📦 ${item.nama}</b>\n\n` +
                 `<b>├⌑ 💰 𝖧𝖺𝗋𝗀𝖺 :</b> ${toRupiah(item.harga)}\n` +
                 `<b>├⌑ 📝 𝖣𝖾𝗌𝗄𝗋𝗂𝗉𝗌𝗂 :</b>\n${item.deskripsi || 'Tidak ada deskripsi'}\n` +
                 `<b>└⌑ 🍂 𝖳𝖾𝗋𝗂𝗆𝖺𝗄𝖺𝗌𝗂𝗁 𝖲𝗎𝖽𝖺𝗁 𝖮𝗋𝖽𝖾𝗋!</b>`, 
        filename: item.fileName || `${item.nama}.zip`,
        parse_mode: "HTML"
      });

      sendTestimoniKeChannel(userNameFull, userId, `Script: ${item.nama}`, item.harga);
    } 

    else if (productData.type === "app") {
      const db = readDb();
      const app = db.apps[productData.idx];
      
      if (!app) {
        return safeReply(ctx, "<blockquote>❌ <b>Aplikasi tidak ditemukan!</b> Silakan hubungi owner.</blockquote>", { parse_mode: "HTML" });
      }
      
      app.accounts = app.accounts || [];
      
      if (app.accounts.length < productData.qty) {
        return safeReply(ctx, `<blockquote>❌ <b>Stok tidak mencukupi!</b>\nStok tersedia: ${app.accounts.length}\nYang dibeli: ${productData.qty}</blockquote>`, { parse_mode: "HTML" });
      }
      
      const taken = [];
      for (let i = 0; i < productData.qty; i++) {
        const acc = app.accounts.shift();
        if (acc) taken.push(acc);
      }
      
      saveDb(db);
      
      let msg = `<blockquote><b>✅ Transaksi Sukses</b>\n\n<b>» Produk :</b> ${app.nama}\n<b>» Jumlah Beli :</b> ${productData.qty}\n<b>» Total Harga :</b> ${toRupiah(productData.total)}\n<b>» Deskripsi Produk :</b> ${app.deskripsi || '-'}\n\n</blockquote>`;
      
      taken.forEach((a, i) => {
        msg += `<blockquote><b>— Akun ${i+1} —</b>\n<b>Username:</b> ${a.user}\n<b>Password:</b> ${a.pass}\n<b>Link Akses:</b> ${a.link}\n<b>Deskripsi:</b> ${a.desc || '-'}\n\n</blockquote>`;
      });
      
      safeReply(ctx, msg, { parse_mode: "HTML" });
      sendTestimoniKeChannel(userNameFull, userId, `App: ${app.nama} x${productData.qty}`, productData.total);
    } 

    else if (productData.type === "panel") {
      ctx.reply("<blockquote>⏳ <b>Sedang membuat akun panel...</b></blockquote>", { parse_mode: "HTML" });
      
      let disk, cpu;
      if (productData.ram === 0) {
        disk = 0;
        cpu = 0;
      } else {
        const gb = productData.ram / 1024;
        disk = gb * 2048;
        cpu = gb * 50;
      }
      
      const result = await createPanelAccount(productData.username, productData.ram, disk, cpu);
      
      if (result.success) {
        const d = result.data;
        ctx.reply(
          `<blockquote><b>✅ PANEL BERHASIL DIBUAT</b>\n\n<b>👤 User:</b> ${productData.username}\n<b>🆔 ID:</b> <code>${d.username}</code>\n<b>🔑 PW:</b> <code>${d.password}</code>\n<b>🌐 Login:</b> ${d.login}</blockquote>`,
          { parse_mode: "HTML" }
        );

        sendTestimoniKeChannel(userNameFull, userId, `Panel ${productData.ram === 0 ? "Unlimited" : productData.ram/1024 + "GB"}`, productData.price);
      } else {
        ctx.reply(`<blockquote>⚠️ <b>Gagal:</b> ${result.msg}</blockquote>`, { parse_mode: "HTML" });
      }
    } 

    else if (productData.type === "admin_panel") {
      await ctx.reply("<blockquote>⏳ <b>Sedang membuat akun Admin Panel...</b></blockquote>", { parse_mode: "HTML" });

      const result = await createAdminAccount(productData.username);

      if (result.success) {
          const d = result.data;
          const msg = `<blockquote><b>🛠️ 𝗔𝗗𝗠𝗜𝗡 𝗣𝗔𝗡𝗘𝗟 𝗕𝗘𝗥𝗛𝗔𝗦𝗜𝗟 𝗗𝗜𝗕𝗨𝗔𝗧</b>
━━━━━━━━━━━━━━━━━━━━━━━━━⨳
<b>👤 𝖴𝗌𝖾𝗋 :</b> ${productData.username}
<b>🆔 𝖴𝗌𝖾𝗋𝗇𝖺𝗆𝖾 :</b> <code>${d.username}</code>
<b>🔑 𝖯𝖺𝗌𝗌𝗐𝗈𝗋𝖽 :</b> <code>${d.password}</code>
<b>📧 𝖤𝗆𝖺𝗂𝗅 :</b> ${d.email}
<b>🌐 𝖫𝗈𝗀𝗂𝗇 :</b> ${d.login}
<b>🛡️ 𝖠𝖼𝖼𝖾𝗌𝗌 :</b> ROOT ADMIN (Full Control)
━━━━━━━━━━━━━━━━━━━━━━━━━⨳
<i>📝 𝖭𝗈𝗍𝖾 : 𝖲𝗂𝗆𝗉𝖺𝗇 𝖣𝖺𝗍𝖺 𝖨𝗇𝗂 𝖣𝖺𝗇 𝖩𝖺𝗇𝗀𝖺𝗇
𝖣𝗂𝗌𝖾𝖻𝖺𝗋𝗄𝖺𝗇 𝖲𝖾𝖼𝖺𝗋𝖺 𝖦𝗋𝖺𝗍𝗂𝗌!</i></blockquote>`;

          await ctx.reply(msg, { parse_mode: "HTML" });
          sendTestimoniKeChannel(userNameFull, userId, `Admin Panel (${d.username})`, productData.price);
      } else {
          await ctx.reply(`<blockquote>⚠️ <b>Gagal membuat Admin Panel:</b> ${result.msg}\nSilakan hubungi owner.</blockquote>`, { parse_mode: "HTML" });
      }
    }

    else if (productData.type === "reseller_panel") {
      const link = config.linkResellerPanel || "https://t.me/LinkBelumDiset";
      
      const msg = `<blockquote><b>🤝 𝗪𝗘𝗟𝗖𝗢𝗠𝗘 𝗡𝗘𝗪 𝗥𝗘𝗦𝗘𝗟𝗟𝗘𝗥 𝗣𝗔𝗡𝗘𝗟</b>
━━━━━━━━━━━━━━━━━━━━━━━⨳
<b>🚀 𝖳𝖾𝗋𝗂𝗆𝖺𝗄𝖺𝗌𝗂𝗁 𝖲𝗎𝖽𝖺𝗁 𝖬𝖾𝗆𝖻𝖾𝗅𝗂 𝖱𝖾𝗌𝖾𝗅𝗅𝖾𝗋
𝖯𝖺𝗇𝖾𝗅 𝖪𝖺𝗆𝗂!</b>
<b>🔗 𝖡𝖾𝗋𝗂𝗄𝗎𝗍 𝖫𝗂𝗇𝗄 𝖦𝗋𝗎𝖻 𝖱𝖾𝗌𝖾𝗅𝗅𝖾𝗋 𝖯𝖺𝗇𝖾𝗅 :</b>
${link}

🍂 <i>𝖲𝗂𝗅𝖺𝗁𝗄𝖺𝗇 𝖡𝖾𝗋𝗀𝖺𝖻𝗎𝗇𝗀 𝖦𝗋𝗎𝖻 𝖱𝖾𝗌𝖾𝗅𝗅𝖾𝗋
𝖯𝖺𝗇𝖾𝗅 𝖣𝗂𝖺𝗍𝖺𝗌 𝖣𝖺𝗇 𝖪𝗈𝗇𝖿𝗂𝗆𝖺𝗌𝗂 𝖪𝖾 𝖮𝗐𝗇𝖾𝗋.</i>
━━━━━━━━━━━━━━━━━━━━━━━⨳</blockquote>`;

      await ctx.reply(msg, { 
          parse_mode: "HTML",
          disable_web_page_preview: true 
      });

      sendTestimoniKeChannel(userNameFull, userId, "Join Reseller Panel", productData.price);
    }

    else if (productData.type === "vps") {
      const loadingMsg = await ctx.reply("<blockquote>⏳ <b>Sedang membuat VPS DigitalOcean...</b>\nProses membutuhkan waktu ±60 detik.</blockquote>", { 
        parse_mode: "HTML" 
      });
      
      try {
        productData.vpsData.username = username;
        
        const result = await createVPSDroplet(userId, productData.vpsData);
        
        try { await ctx.deleteMessage(loadingMsg.message_id); } catch (e) {}
        
        if (result.success) {
          const data = result.data;
          const paketInfo = {
            low: { garansi: 7, replace: 1 },
            medium: { garansi: 15, replace: 2 },
            high: { garansi: 30, replace: -1 }
          };
          
          const paket = productData.vpsData.paket;
          
          const detailVPS = `<blockquote>✅ <b>𝗩𝗣𝗦 𝗕𝗘𝗥𝗛𝗔𝗦𝗜𝗟 𝗗𝗜𝗕𝗨𝗔𝗧!</b></blockquote>

<blockquote>🖥️ <b>𝗕𝗘𝗥𝗜𝗞𝗨𝗧 𝗗𝗘𝗧𝗔𝗜𝗟 𝗩𝗣𝗦</b>
━━━━━━━━━━━━━━━━━━━━━━━━━⨳
<b>🌐 𝖨𝖯 𝖠𝖣𝖣𝖱𝖤𝖲𝖲:</b> <code>${data.ip}</code>
<b>🆔 𝖴𝖲𝖤𝖱𝖭𝖠𝖬𝖤 :</b> <code>root</code>
<b>🔐 𝖯𝖠𝖲𝖲𝖶𝖮𝖱𝖣 :</b> <code>${data.password}</code>
<b>🧩 𝖧𝖮𝖲𝖳𝖭𝖠𝖬𝖤 :</b> ${data.hostname}
<b>🌍 𝖱𝖤𝖦𝖨𝖮𝖭 :</b> ${data.region.toUpperCase()}
<b>💿 𝖮𝖲 :</b> ${data.os.toUpperCase()}</blockquote>

<blockquote>🛍️ <b>𝗗𝗘𝗧𝗔𝗜𝗟 𝗣𝗘𝗠𝗕𝗘𝗟𝗜𝗔𝗡</b>
━━━━━━━━━━━━━━━━━━━━━━━━━⨳
<b>📦 𝖯𝖠𝖪𝖤𝖳 :</b> ${paket.toUpperCase()}
<b>💾 𝖲𝖯𝖤𝖲𝖨𝖥𝖨𝖪𝖠𝖲𝖨 :</b> ${productData.vpsData.plan}
<b>💰 𝖧𝖠𝖱𝖦𝖠 :</b> ${toRupiah(productData.vpsData.harga)}
<b>🛡️ 𝖦𝖠𝖱𝖠𝖭𝖲𝖨 :</b> ${paketInfo[paket].garansi} Hari
<b>♻️ 𝖱𝖤𝖯𝖫𝖠𝖢𝖤 :</b> ${paketInfo[paket].replace === -1 ? "Unlimited" : paketInfo[paket].replace + "x"}
<b>📅 𝖳𝖠𝖭𝖦𝖦𝖠𝖫 :</b> ${data.created}
<b>👤 𝖯𝖤𝖬𝖡𝖤𝖫𝖨 :</b> ${username}
<b>🤝 𝖯𝖤𝖭𝖩𝖴𝖠𝖫 :</b> @${bot.botInfo.username}</blockquote>`;
          
          await ctx.reply(detailVPS, { parse_mode: "HTML" });
          
          await ctx.reply(
            `<blockquote>📌 <b>𝗜𝗡𝗙𝗢𝗥𝗠𝗔𝗦𝗜 𝗣𝗘𝗡𝗧𝗜𝗡𝗚</b>
━━━━━━━━━━━━━━━━━━━━━━━━⨳
• Gunakan IP <code>${data.ip}</code> untuk akses VPS
• Login dengan username <code>root</code> dan password di atas
• VPS sudah ready untuk digunakan
• Jika ada masalah, silakan hubungi admin</blockquote>`,
            { parse_mode: "HTML" }
          );

          try {
             const testiText = `🖥️ <b>𝗩𝗣𝗦 𝗕𝗘𝗥𝗛𝗔𝗦𝗜𝗟 𝗗𝗜𝗕𝗘𝗟𝗜!</b>\n\n` +
              `👤 <b>𝖯𝖾𝗆𝖻𝖾𝗅𝗂 :</b> ${username}\n` +
              `📦 <b>𝖯𝖺𝗄𝖾𝗍 :</b> ${paket.toUpperCase()}\n` +
              `💾 <b>𝖲𝗉𝖾𝗄 :</b> ${productData.vpsData.plan}\n` +
              `💰 <b>𝖧𝖺𝗋𝗀𝖺 :</b> ${toRupiah(productData.vpsData.harga)}\n` +
              `🕒 <b>𝖶𝖺𝗄𝗍𝗎 :</b> ${new Date().toLocaleString("id-ID")}\n\n` +
              `🎉 <b>𝖳𝗋𝖺𝗇𝗌𝖺𝗄𝗌𝗂 𝖲𝗎𝖼𝖼𝖾𝗌𝗌𝖿𝗎𝗅!</b>`;
            
            if(config.testimoniChannel) {
                await bot.telegram.sendMessage(config.testimoniChannel, testiText, {
                  parse_mode: "HTML",
                  reply_markup: {
                    inline_keyboard: [[{ text: "🛒 𝗢𝗿𝗱𝗲𝗿 𝗩𝗣𝗦", url: `https://t.me/${bot.botInfo.username}?start=shop` }]]
                  }
                });
            }
          } catch (e) {}
          
          sendTestimoniKeChannel(userNameFull, userId, `VPS ${paket.toUpperCase()} - ${productData.vpsData.plan}`, productData.vpsData.harga);
          
        } else {
          await ctx.reply(`<blockquote>❌ <b>Gagal membuat VPS:</b> ${result.msg}</blockquote>`, { parse_mode: "HTML" });
          await ctx.reply(
            `<blockquote>⚠️ <b>TRANSAKSI GAGAL</b>\n\nMaaf, terjadi kesalahan saat membuat VPS Anda.\n\nSilakan:\n1. Hubungi admin untuk bantuan\n2. Atau minta refund melalui admin</blockquote>`,
            { parse_mode: "HTML" }
          );
          
          try {
            await bot.telegram.sendMessage(config.ownerId, 
              `<b>🚨 ERROR BUAT VPS!</b>\nUser: ${username}\nError: ${result.msg}\nPaket: ${productData.vpsData.paket}`, {parse_mode: "HTML"}
            );
          } catch(e){}
        }
        
        if (userState[userId]?.vpsData) delete userState[userId].vpsData;
        
      } catch (error) {
        try { await ctx.deleteMessage(loadingMsg.message_id); } catch (e) {}
        await ctx.reply(`<blockquote>❌ <b>Error sistem VPS:</b> ${error.message}</blockquote>`, { parse_mode: "HTML" });
      }
    }

  } catch (error) {
    console.error("[ERROR] Error sending product:", error);
    safeReply(ctx, "<blockquote>❌ <b>Gagal mengirim produk.</b> Silakan hubungi owner.</blockquote>", { parse_mode: "HTML" });
  }
}

bot.on("photo", async (ctx) => {
  try {
    const userId = ctx.from.id;
    const state = userState[userId];
    
    if (state?.step === "PAYMENT_MANUAL_PENDING") {
      const photos = ctx.message.photo || [];
      if (photos.length === 0) {
        await ctx.reply("❌ Foto tidak ditemukan. Silakan kirim ulang.");
        return;
      }
      
      const bestPhoto = photos[photos.length - 1];
      
      const paymentData = {
        userId: userId,
        userName: `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim(),
        userUsername: ctx.from.username ? `@${ctx.from.username}` : '-',
        itemName: state.itemName,
        amount: state.amount,
        nominal: state.nominal,
        proofPhotoId: bestPhoto.file_id,
        timestamp: Date.now(),
        status: "pending",
        productData: state.productData
      };
      
      const payments = readManualPayments();
      const paymentIndex = payments.length;
      payments.push(paymentData);
      saveManualPayments(payments);
      
      delete userState[userId];
      
      try {
        await bot.telegram.sendPhoto(config.ownerId, paymentData.proofPhotoId, {
          caption: `<blockquote><b>🧾 BUKTI PEMBAYARAN MANUAL</b>\n\n<b>👤 User:</b> ${paymentData.userName}\n<b>🆔 ID:</b> ${paymentData.userId}\n<b>📛 Username:</b> ${paymentData.userUsername}\n\n<b>🛒 Item:</b> ${paymentData.itemName}\n<b>💰 Amount:</b> ${toRupiah(paymentData.amount)}\n<b>⏰ Time:</b> ${new Date(paymentData.timestamp).toLocaleString()}\n\n<i>Verifikasi pembayaran ini:</i></blockquote>`,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Terima & Kirim Produk", callback_data: `approve_payment_${paymentIndex}` },
                { text: "❌ Tolak", callback_data: `reject_payment_${paymentIndex}` }
              ]
            ]
          }
        });
        
        await ctx.reply("<blockquote>✅ <b>Bukti pembayaran telah dikirim ke owner!</b>\nSilakan tunggu verifikasi. Status akan diberitahu.</blockquote>", { parse_mode: "HTML" });
        
      } catch (ownerError) {
        console.error("[ERROR] Error sending to owner:", ownerError);
        await ctx.reply("<blockquote>❌ <b>Gagal mengirim bukti ke owner.</b> Silakan coba lagi atau hubungi owner langsung.</blockquote>", { parse_mode: "HTML" });
        userState[userId] = state;
      }
      
      return;
    }
    
  } catch (e) {
    console.error("[ERROR] Payment proof error:", e);
    try {
      await ctx.reply("<blockquote>❌ <b>Terjadi kesalahan saat memproses bukti pembayaran.</b> Silakan coba lagi.</blockquote>", { parse_mode: "HTML" });
    } catch (replyError) {
      console.error("[ERROR] Cannot send error message:", replyError);
    }
  }
});

bot.action(/approve_payment_(\d+)/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    await ctx.answerCbQuery("❌ Hanya owner yang boleh verifikasi!", { show_alert: true });
    return;
  }
  
  const paymentIndex = parseInt(ctx.match[1]);
  const payments = readManualPayments();
  const payment = payments[paymentIndex];
  
  if (!payment) {
    await ctx.answerCbQuery("❌ Pembayaran tidak ditemukan/terhapus!", { show_alert: true });
    return;
  }
  
  if (payment.status !== "pending") {
    await ctx.answerCbQuery("❌ Pembayaran ini sudah diproses sebelumnya!", { show_alert: true });
    return;
  }
  
  payment.status = "approved";
  payment.approvedBy = ctx.from.id;
  payment.approvedAt = Date.now();
  saveManualPayments(payments);
  
  try {
    await ctx.editMessageCaption(
      `<blockquote><b>✅ PEMBAYARAN DITERIMA</b>\n\n` +
      `<b>👤 User:</b> ${payment.userName}\n` +
      `<b>🛒 Item:</b> ${payment.itemName}\n` +
      `<b>💰 Amount:</b> ${toRupiah(payment.amount)}\n` +
      `<b>⏰ Approved:</b> ${new Date(payment.approvedAt).toLocaleString()}</blockquote>`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    console.error("[ERROR] Failed to edit message caption:", e.message);
  }
  
  try {
    const fakeCtx = {
      from: { 
        id: payment.userId, 
        first_name: payment.userName.split(' ')[0] || payment.userName,
        last_name: payment.userName.split(' ').slice(1).join(' ') || ''
      },
      reply: (text, extra) => bot.telegram.sendMessage(payment.userId, text, extra),
      replyWithDocument: (file_id, extra) => bot.telegram.sendDocument(payment.userId, file_id, extra),
      telegram: bot.telegram
    };
    
    if (payment.productData) {
      
      if (payment.productData.type === "topup_saldo") {
          const dbSaldoPath = "./database/saldoOtp.json";
          let saldoData = {};
          
          try {
            if (fs.existsSync(dbSaldoPath)) {
                saldoData = JSON.parse(fs.readFileSync(dbSaldoPath, "utf8"));
            }
          } catch(err) { saldoData = {}; }
          
          const saldoMasuk = payment.productData.amount || payment.amount;
          
          saldoData[payment.userId] = (saldoData[payment.userId] || 0) + saldoMasuk;
          fs.writeFileSync(dbSaldoPath, JSON.stringify(saldoData, null, 2));
          
          await bot.telegram.sendMessage(
            payment.userId, 
            `✅ <b>DEPOSIT SUKSES!</b>\n\n💰 Saldo Masuk: <b>${toRupiah(saldoMasuk)}</b>\n💼 Total Saldo: <b>${toRupiah(saldoData[payment.userId])}</b>`, 
            {parse_mode:"HTML"}
          );
          
          sendTestimoniKeChannel(payment.userName, payment.userId, "Deposit Saldo", saldoMasuk);
      } 
      
      else {
          await sendProductToUser(fakeCtx, payment.productData);
          
          sendTestimoniKeChannel(payment.userName, payment.userId, payment.itemName, payment.amount);
      }
      
      await bot.telegram.sendMessage(config.ownerId,
        `<blockquote><b>📦 TRANSAKSI SELESAI</b>\n\n` +
        `<b>👤 User:</b> ${payment.userName}\n` +
        `<b>🆔 ID:</b> ${payment.userId}\n` +
        `<b>🛒 Item:</b> ${payment.itemName}\n` +
        `<b>💰 Amount:</b> ${toRupiah(payment.amount)}\n` +
        `<b>✅ Status:</b> Sukses dikirim/ditambahkan</blockquote>`,
        { parse_mode: "HTML" }
      );
    }
    
    await ctx.answerCbQuery("✅ Pembayaran diterima & diproses!");
    
  } catch (error) {
    console.error("[ERROR] Error in payment approval:", error);
    await bot.telegram.sendMessage(config.ownerId, 
      `<blockquote><b>⚠️ ERROR PROSES TRANSAKSI</b>\n\n` +
      `<b>User:</b> ${payment.userName} (${payment.userId})\n` +
      `<b>Error:</b> ${error.message}\n\n` +
      `<i>Saldo/Produk mungkin belum masuk. Cek manual!</i></blockquote>`,
      { parse_mode: "HTML" }
    );
  }
});

bot.action(/reject_payment_(\d+)/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    await ctx.answerCbQuery("❌ Hanya owner yang boleh verifikasi!", { show_alert: true });
    return;
  }
  
  const paymentIndex = parseInt(ctx.match[1]);
  const payments = readManualPayments();
  const payment = payments[paymentIndex];
  
  if (!payment) {
    await ctx.answerCbQuery("❌ Pembayaran tidak ditemukan!", { show_alert: true });
    return;
  }
  
  if (payment.status !== "pending") {
    await ctx.answerCbQuery("❌ Pembayaran sudah diverifikasi!", { show_alert: true });
    return;
  }
  
  payment.status = "rejected";
  payment.rejectedBy = ctx.from.id;
  payment.rejectedAt = Date.now();
  saveManualPayments(payments);
  
  try {
    await ctx.editMessageCaption(`<blockquote><b>❌ PEMBAYARAN DITOLAK</b>\n\n<b>👤 User:</b> ${payment.userName}\n<b>🛒 Item:</b> ${payment.itemName}\n<b>💰 Amount:</b> ${toRupiah(payment.amount)}\n<b>⏰ Rejected:</b> ${new Date(payment.rejectedAt).toLocaleString()}</blockquote>`,
      { parse_mode: "HTML" });
  } catch (e) {
    console.error("[ERROR] Failed to edit message caption:", e);
  }
  
  try {
    await bot.telegram.sendMessage(payment.userId, 
      `<blockquote><b>❌ Pembayaran Anda ditolak!</b>\n\n<b>Alasan:</b> Bukti transfer tidak valid / nominal tidak sesuai.\n<i>Silakan hubungi owner untuk informasi lebih lanjut.</i></blockquote>`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    console.error("[ERROR] Failed to send rejection message to user:", e);
  }
  
  await ctx.answerCbQuery("❌ Pembayaran ditolak!");
});

bot.command(["withdraw", "wd"], async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;

  const args = ctx.message.text.split(" ");
  const nominal = parseInt(args[1]);

  if (!nominal || isNaN(nominal) || nominal < 1000) {
    return ctx.reply("<blockquote>💰 <b>Gunakan:</b> <code>/withdraw [nominal]</code>\nMinimal Rp 1.000</blockquote>", { parse_mode: "HTML" });
  }

  try {
    const waitMsg = await ctx.reply("⏳ <b>Memproses withdraw...</b>", { parse_mode: "HTML" });
    
    const atlConfig = {
      apiAtlantic: config.ApikeyAtlantic,
      wd_balance: config.wd_balance
    };

    const res = await atlanticTransfer(nominal, atlConfig);

    if (!res.status) throw new Error(res.message);

    const data = res.data;
    const caption = `<blockquote>✅ <b>PERMINTAAN WITHDRAW DIBUAT</b>\n\n` +
      `<b>Reff ID:</b> <code>${data.reff_id}</code>\n` +
      `<b>Transfer ID:</b> <code>${data.id}</code>\n` +
      `<b>Tujuan:</b> ${data.nomor_tujuan} (${data.nama})\n` +
      `<b>Nominal:</b> ${toRupiah(data.nominal)}\n` +
      `<b>Fee:</b> ${toRupiah(data.fee)}\n\n` +
      `<i>Menunggu konfirmasi transfer...</i></blockquote>`;

    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, caption, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Cek Status WD", `check_wd_${data.id}`)]
      ])
    });

  } catch (err) {
    ctx.reply(`❌ <b>Error:</b> ${err.message}`, { parse_mode: "HTML" });
  }
});

bot.action(/check_wd_(.+)/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("Bukan Owner!");
  const wdId = ctx.match[1];
  
  try {
    const res = await atlanticTransferStatus(wdId, config.ApikeyAtlantic);
    const status = res.data?.status || "processing";
    
    await ctx.answerCbQuery(`Status: ${status.toUpperCase()}`);
    
    if (status === "success") {
      await ctx.editMessageCaption(`<blockquote>✅ <b>WD BERHASIL!</b>\nID: <code>${wdId}</code>\nStatus: <b>SUCCESS</b></blockquote>`, { parse_mode: "HTML" });
    }
  } catch (e) {
    ctx.answerCbQuery("Gagal cek status.");
  }
});

bot.action("menu_wd_info", (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang bisa melihat info WD!", { show_alert: true });
  }
  
  function sensorString(input, visibleCount = 3, maskChar = 'X') {
    if (!input || input.length <= visibleCount) return input || "Tidak tersedia";
    const visiblePart = input.slice(0, visibleCount);
    const maskedPart = maskChar.repeat(input.length - visibleCount);
    return visiblePart + maskedPart;
  }
  
  function sensorWithSpace(str, visibleCount = 3, maskChar = 'X') {
    if (!str) return "Tidak tersedia";
    let result = '';
    let count = 0;
    for (let char of str) {
      if (char === ' ') {
        result += char;
      } else if (count < visibleCount) { 
        result += char; 
        count++; 
      } else {
        result += maskChar;
      }
    }
    return result;
  }
  
  const wdInfo = config.wd_balance || {};
  
  const infoText = `<blockquote><b>💰 𝗜𝗡𝗙𝗢 𝗪𝗜𝗧𝗛𝗗𝗥𝗔𝗪</b>\n\n` +
    `<b>├⌑ 𝖡𝖺𝗇𝗄/𝖤-𝖶𝖺𝗅𝗅𝖾𝗍 :</b> ${wdInfo.bank_code || "Belum diatur"}\n` +
    `<b>├⌑ 𝖳𝗎𝗃𝗎𝖺𝗇 :</b> ${sensorString(wdInfo.destination_number)}\n` +
    `<b>└⌑ 𝖭𝖺𝗆𝖺 :</b> ${sensorWithSpace(wdInfo.destination_name)}\n\n` +
    `𝖪𝖾𝗍𝗂𝗄 <code>/withdraw [jumlah]</code> untuk menarik saldo.\n` +
    `<b>𝖢𝗈𝗇𝗍𝗈𝗁 :</b> <code>/withdraw 50000</code>\n` +
    `<b>𝖬𝗂𝗇𝗂𝗆𝖺𝗅 :</b> Rp 1.000</blockquote>`;
  
  ctx.editMessageText(infoText, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", callback_data: "menu_owner" }]
      ]
    }
  }).catch(() => {
    ctx.reply(infoText, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", callback_data: "menu_owner" }]
        ]
      }
    });
  });
  
  ctx.answerCbQuery();
});

bot.command("cancel", (ctx) => cancelTransaction(ctx));
bot.action("cancel_trx", (ctx) => cancelTransaction(ctx));
async function cancelTransaction(ctx) {
  const userId = ctx.from.id;
  
  if (activeTransactions[userId]) {
    try {
      if (activeTransactions[userId].messageId) {
        await ctx.deleteMessage(activeTransactions[userId].messageId).catch(() => {});
      }
    } catch (e) {}
    
    delete activeTransactions[userId];
    
    if (userState[userId]) {
      delete userState[userId];
    }
    
    await safeReply(ctx, "<blockquote>✅ <b>Transaksi dibatalkan.</b></blockquote>", { parse_mode: "HTML" });
  } else {
    await safeReply(ctx, "<blockquote>ㅤ<b>ㅤ</b></blockquote>", { parse_mode: "HTML" });
  }
  
  if (ctx.updateType === 'callback_query') {
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
  }
}

bot.command("ytsearch", async (ctx) => {
  const query = ctx.message.text.split(" ").slice(1).join(" ");
  if (!query) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/ytsearch judul lagu / keyword</code></blockquote>", { parse_mode: "HTML" });

  try {
    await safeReply(ctx, "<blockquote>🔍 <b>Mencari video di YouTube...</b></blockquote>", { parse_mode: "HTML" });

    const api = `https://api-ralzz.vercel.app/search/youtube?apikey=ubot&q=${encodeURIComponent(query)}`;
    const res = await axios.get(api);

    if (!res.data || !res.data.result || res.data.result.length === 0) {
      return safeReply(ctx, "<blockquote>❌ <b>Tidak ada hasil ditemukan.</b></blockquote>", { parse_mode: "HTML" });
    }

    const results = res.data.result.slice(0, 10); 

    results.forEach((vid, i) => {
      const text =
`<b>🎬 ${vid.title}</b>
<b>👤 Channel:</b> ${vid.author?.name || "-"}
<b>⏱ Durasi:</b> ${vid.duration?.timestamp || "-"}
<b>👁 Views:</b> ${vid.views?.toLocaleString() || "-"}

<b>🔗</b> ${vid.url}`;

      safeReply(ctx, text, { parse_mode: "HTML" });
    });

  } catch (err) {
    console.error(err);
    safeReply(ctx, "<blockquote>❌ <b>Error mengambil data pencarian YouTube.</b></blockquote>", { parse_mode: "HTML" });
  }
});

bot.command("ssweb", async (ctx) => {
  const url = ctx.message.text.split(" ")[1];
  if (!url) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/ssweb url</code></blockquote>", { parse_mode: "HTML" });

  try {
    safeReply(ctx, "<blockquote>⏳ <b>Mengambil screenshot...</b></blockquote>", { parse_mode: "HTML" });

    const api = `https://api-ralzz.vercel.app/tools/ssweb?apikey=ubot&url=${encodeURIComponent(url)}`;
    const res = await axios.get(api);

    if (!res.data || !res.data.result) {
      return safeReply(ctx, "<blockquote>❌ <b>Gagal mengambil screenshot.</b></blockquote>", { parse_mode: "HTML" });
    }

    await ctx.replyWithPhoto(res.data.result, {
      caption: "<blockquote>✅ <b>Screenshot berhasil!</b></blockquote>",
      parse_mode: "HTML"
    });

  } catch (err) {
    console.error(err);
    safeReply(ctx, "<blockquote>❌ <b>Error: tidak bisa mengambil screenshot.</b></blockquote>", { parse_mode: "HTML" });
  }
});

bot.command("makeqr", async(ctx) => {
  const txt = ctx.message.text.replace("/makeqr", "").trim();
  if (!txt) return safeReply(ctx, "<blockquote><b>Gunakan:</b> <code>/makeqr teks</code></blockquote>", { parse_mode: "HTML" });
  ctx.replyWithPhoto(`https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(txt)}`);
});

bot.command("tiktokmp4", async (ctx) => {
  const url = ctx.message.text.split(" ")[1];
  if (!url) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/tiktok url</code></blockquote>", { parse_mode: "HTML" });
  try {
    safeReply(ctx, "<blockquote>⏳ <b>Mengambil video TikTok...</b></blockquote>", { parse_mode: "HTML" });
    const res = await axios.get(`https://api-ralzz.vercel.app/download/tiktok?apikey=ubot&url=${encodeURIComponent(url)}`);
    if (!res.data.result.video_sd) return safeReply(ctx, "<blockquote>❌ <b>Gagal mengambil video!</b></blockquote>", { parse_mode: "HTML" });
    await ctx.replyWithVideo(res.data.video_sd, { caption: "<blockquote>✅ <b>TikTok Tanpa Watermark</b></blockquote>", parse_mode: "HTML" });
  } catch (e) { console.log(e); safeReply(ctx, "<blockquote>❌ <b>Error: tidak bisa download TikTok.</b></blockquote>", { parse_mode: "HTML" }); }
});

bot.command("ytmp3", async (ctx) => {
  const url = ctx.message.text.split(" ")[1];
  if (!url) return safeReply(ctx, "<blockquote><b>Gunakan:</b> <code>/ytmp3 url</code></blockquote>", { parse_mode: "HTML" });
  safeReply(ctx, "<blockquote>⏳ <b>Mengambil audio...</b></blockquote>", { parse_mode: "HTML" });
  try {
    const res = await axios.get(`https://api-ralzz.vercel.app/download/ytmp3v2?apikey=ubot&url=${encodeURIComponent(url)}`);
    await ctx.replyWithAudio(res.data.result, { caption: "<blockquote>🎵 <b>YouTube Audio Downloaded</b></blockquote>", parse_mode: "HTML" });
  } catch (e) { safeReply(ctx, "<blockquote>❌ <b>Gagal mengambil audio.</b></blockquote>", { parse_mode: "HTML" }); }
});

bot.command("shorten", async (ctx) => {
  const url = ctx.message.text.split(" ")[1];
  if (!url) return safeReply(ctx, "<blockquote><b>Gunakan:</b> <code>/shorten url</code></blockquote>", { parse_mode: "HTML" });
  try {
    const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`);
    safeReply(ctx, `<blockquote><b>🔗 Shortened URL:</b>\n${res.data}</blockquote>`, { parse_mode: "HTML" });
  } catch (e) { safeReply(ctx, "<blockquote>❌ <b>Gagal memendekkan URL.</b></blockquote>", { parse_mode: "HTML" }); }
});

bot.command("checkerror", async (ctx) => {
    if (!ctx.message.reply_to_message?.document)
        return safeReply(ctx, "<blockquote>❌ <b>Reply file untuk dianalisa!</b></blockquote>", { parse_mode: "HTML" });

    const file = ctx.message.reply_to_message.document;
    const fileId = file.file_id;
    const fileName = file.file_name;

    const limit = updateUserLimit(ctx.from.id);
    if (limit < 0) return safeReply(ctx, "<blockquote>❌ <b>Limit habis!</b> Upgrade ke premium.</blockquote>", { parse_mode: "HTML" });

    try {
        safeReply(ctx, "<blockquote>📥 <b>Mengunduh & menganalisa file...</b></blockquote>", { parse_mode: "HTML" });

        const buff = await downloadFile(fileId);
        const content = getFileContent(buff);

        const analysis = await analyzeErrorWithGemini(content, fileName);

        safeReply(ctx, `<b>📄 Hasil Analisis:</b>\n\n${analysis}\n\n<b>Sisa limit:</b> ${getUserLimit(ctx.from.id)}`,
            { parse_mode: "HTML" }
        );
    } catch (err) {
        safeReply(ctx, "<blockquote>❌ <b>Error:</b></blockquote>" + err.message, { parse_mode: "HTML" });
    }
});

bot.command("fixerror", async (ctx) => {
    if (!ctx.message.reply_to_message?.document)
        return safeReply(ctx, "❌ <b>Reply file untuk diperbaiki!</b>", { parse_mode: "HTML" });

    const file = ctx.message.reply_to_message.document;
    const fileId = file.file_id;
    const fileName = file.file_name;

    const limit = updateUserLimit(ctx.from.id);
    if (limit < 0) return safeReply(ctx, "❌ <b>Limit habis!</b> Upgrade ke premium.", { parse_mode: "HTML" });

    try {
        safeReply(ctx, "🔧 <b>Memperbaiki error dengan Gemini...</b>", { parse_mode: "HTML" });

        const buff = await downloadFile(fileId);
        const content = getFileContent(buff);

        const fixed = await fixErrorWithGemini(content, fileName);

        ctx.replyWithDocument(
            { source: Buffer.from(fixed), filename: `fixed_${fileName}` },
            { caption: `✔ <b>Error berhasil diperbaiki!</b>\n<b>Sisa limit:</b> ${getUserLimit(ctx.from.id)}`, parse_mode: "HTML" }
        );
    } catch (err) {
        safeReply(ctx, "❌ <b>Error:</b> " + err.message, { parse_mode: "HTML" });
    }
});

bot.command("qc", async (ctx) => {
  try {
    const reply = ctx.message.reply_to_message;

    if (!reply) {
      return ctx.reply(
        "❌ <b>Contoh penggunaan:</b> <code>/qc (reply pesan)</code>",
        { parse_mode: "HTML" }
      );
    }

    const target = reply.forward_from || reply.from;
    const username = target.first_name || "User";

    let avatarUrl = "https://files.catbox.moe/nwvkbt.png";

    try {
      const photos = await ctx.telegram.getUserProfilePhotos(target.id, 0, 1);

      if (photos.total_count > 0) {
        const file = await ctx.telegram.getFileLink(photos.photos[0][0].file_id);
        avatarUrl = file.href;
      }
    } catch (err) {
      console.log("Avatar fetch error:", err);
    }

    const messageText = reply.text || reply.caption || "(pesan tidak berisi teks)";

    const payload = {
      type: "quote",
      format: "png",
      backgroundColor: "#000000",
      width: 512,
      height: 768,
      scale: 2,
      messages: [
        {
          entities: [],
          avatar: true,
          from: {
            id: target.id,
            name: username,
            photo: { url: avatarUrl },
          },
          text: messageText,
          replyMessage: {},
        },
      ],
    };

    const loading = await ctx.reply(
      `<blockquote>⏳ <b>Membuat sticker quote...</b></blockquote>`,
      { parse_mode: "HTML" }
    );

    const result = await axios.post(
      "https://bot.lyo.su/quote/generate",
      payload,
      { headers: { "Content-Type": "application/json" } }
    );

    const buffer = Buffer.from(result.data.result.image, "base64");

    await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id);

    await ctx.replyWithSticker({ source: buffer });
  } catch (err) {
    console.error("QC ERROR:", err);
    return ctx.reply(
      `<blockquote>❌ <b>Terjadi kesalahan saat membuat sticker.</b></blockquote>`,
      { parse_mode: "HTML" }
    );
  }
});

bot.command("brat", async (ctx) => {
  const text = ctx.message.text.split(" ").slice(1).join(" ");

  if (!text) {
    return ctx.reply("❌ <b>Contoh:</b> <code>/brat (kata-kata)</code>", {
      parse_mode: "HTML"
    });
  }

  const chatId = ctx.chat.id;
  const tempFilePath = "./brat_temp.webp";

  try {
    await ctx.reply("<blockquote>⏳ <b>Membuat sticker, tunggu sebentar...</b></blockquote>", { parse_mode: "HTML" });

    const imageUrl = `https://kepolu-brat.hf.space/brat?q=${encodeURIComponent(text)}`;

    const downloadFile = async (url, dest) => {
      const writer = fs.createWriteStream(dest);

      const response = await axios({
        url,
        method: "GET",
        responseType: "stream",
      });

      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });
    };

    await downloadFile(imageUrl, tempFilePath);

    await ctx.replyWithSticker({ source: tempFilePath });

    fs.unlinkSync(tempFilePath);

  } catch (err) {
    console.error(err);
    ctx.reply("<blockquote>❌ <b>Terjadi kesalahan saat membuat sticker. Coba lagi nanti.</b></blockquote>", { parse_mode: "HTML" });
  }
});

async function uploadToCatbox(buffer, filename) {
  try {
    const form = new FormData();
    form.append('fileToUpload', buffer, { filename: filename });
    form.append('reqtype', 'fileupload');
    
    const response = await axios.post('https://catbox.moe/user/api.php', form, {
      headers: {
        ...form.getHeaders()
      }
    });
    
    return response.data;
  } catch (error) {
    console.error('Upload error:', error);
    throw error;
  }
}


bot.command("tourl", async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;

    const replyMsg = ctx.message.reply_to_message;
    if (!replyMsg) {
      return ctx.reply(
        `<blockquote>❌ <b>Balas sebuah pesan yang berisi file/audio/video dengan perintah /tourl</b></blockquote>`,
        { parse_mode: "HTML" }
      );
    }

    if (
      !replyMsg.document &&
      !replyMsg.photo &&
      !replyMsg.video &&
      !replyMsg.audio &&
      !replyMsg.voice
    ) {
      return ctx.reply(
        `<blockquote>❌ <b>Pesan yang kamu balas tidak mengandung file/audio/video yang bisa diupload.</b></blockquote>`,
        { parse_mode: "HTML" }
      );
    }

    let fileId, filename;

    if (replyMsg.document) {
      fileId = replyMsg.document.file_id;
      filename = replyMsg.document.file_name;
    } else if (replyMsg.photo) {
      const photoArray = replyMsg.photo;
      fileId = photoArray[photoArray.length - 1].file_id;
      filename = "photo.jpg";
    } else if (replyMsg.video) {
      fileId = replyMsg.video.file_id;
      filename = replyMsg.video.file_name || "video.mp4";
    } else if (replyMsg.audio) {
      fileId = replyMsg.audio.file_id;
      filename = replyMsg.audio.file_name || "audio.mp3";
    } else if (replyMsg.voice) {
      fileId = replyMsg.voice.file_id;
      filename = "voice.ogg";
    }

    const file = await ctx.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;

    const res = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(res.data);

    const catboxUrl = await uploadToCatbox(buffer, filename);

    await ctx.reply(
      `<blockquote>✅ <b>File berhasil diupload ke Catbox:</b>\n<code>${catboxUrl}</code></blockquote>`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    console.error("tourl error:", err);
    
    const cleanError = err.message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    
    ctx.reply(
      `<blockquote>❌ <b>Gagal upload file:</b> ${cleanError}</blockquote>`,
      { parse_mode: "HTML" }
    );
  }
});

function calcTotalPrice(basePrice, qty) {
  if (qty <= 1) return basePrice;
  return basePrice * qty;
}

function renderPurchaseText(app, qty, total) {
  const stock = (app.accounts || []).length;
  return `<b>• Produk :</b> ${app.nama}
<b>• Sisa Stok :</b> ${stock}
<b>• Deskripsi :</b> ${app.deskripsi || '-'}

──────────────

<b>• Jumlah :</b> ${qty}
<b>• Harga Satuan :</b> ${toRupiah(app.harga)}
<b>• Total Harga :</b> ${toRupiah(total)}

<i>Updated: ${new Date().toLocaleTimeString()}</i>`;
}

bot.catch((err, ctx) => {
    console.error("Bot Error:", err);
    safeReply(ctx, "<blockquote>❌ <b>Terjadi kesalahan.</b></blockquote>", { parse_mode: "HTML" });
});

bot.launch().catch((err) => {
  console.error("❌ Gagal connect ke Telegram:", err.message);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));