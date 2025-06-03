const { Telegraf } = require('telegraf');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);

const categories = {
  'chi phí xe ô tô': { emoji: '🚗', subcategories: ['xăng', 'rửa xe', 'vetc', 'sửa chữa', 'vé đỗ xe'] },
  'xăng': { emoji: '⛽', subcategories: ['xăng', 'nhiên liệu'] },
  'rửa xe': { emoji: '🧽', subcategories: ['rửa xe', 'vệ sinh xe'] },
  'vetc': { emoji: '🎫', subcategories: ['vetc', 'thu phí không dừng'] },
  'nhà hàng': { emoji: '🍽️', subcategories: ['ăn sáng', 'ăn trưa', 'ăn tối', 'café'] },
  'ăn sáng': { emoji: '🍳', subcategories: ['phở', 'bánh mì', 'cơm'] },
  'ăn trưa': { emoji: '🍱', subcategories: ['cơm', 'bún', 'phở'] },
  'ăn tối': { emoji: '🍽️', subcategories: ['cơm', 'lẩu', 'nướng'] },
  'café': { emoji: '☕', subcategories: ['cà phê', 'trà', 'nước'] },
  'giao nhận đồ': { emoji: '📦', subcategories: ['giao đồ', 'ship đồ', 'grab food'] },
  'ship đồ': { emoji: '📮', subcategories: ['phí ship', 'giao hàng'] },
  'mua đồ': { emoji: '🛒', subcategories: ['quần áo', 'giày dép', 'mỹ phẩm'] },
  'dịch vụ': { emoji: '🔧', subcategories: ['cắt tóc', 'massage', 'spa'] },
  'chi phí khác': { emoji: '💰', subcategories: ['khác', 'linh tinh'] }
};

const paymentMethods = {
  'tk': 'Chuyển khoản',
  'chuyển khoản': 'Chuyển khoản',
  'banking': 'Chuyển khoản',
  'tm': 'Tiền mặt',
  'tiền mặt': 'Tiền mặt',
  'cash': 'Tiền mặt'
};

function parseExpense(text) {
  const input = text.toLowerCase().trim();
  const amountRegex = /([\d,.]+)[kđvnddngnghìntriệu]?/i;
  const amountMatch = input.match(amountRegex);

  let amount = 0;
  let category = 'Chi phí khác';
  let emoji = '💰';
  let subcategory = 'Khác';
  let paymentMethod = 'Tiền mặt';
  let quantity = 1;
  let type = 'Chi';

  if (amountMatch) {
    let amountStr = amountMatch[1].replace(/[,\.]/g, '');
    amount = parseInt(amountStr);
    if (input.includes('k') || input.includes('nghìn')) {
      if (amount < 1000) amount *= 1000;
    } else if (input.includes('triệu')) {
      amount *= 1000000;
    }
  }

  let bestMatch = '';
  let matchLength = 0;

  for (let cat in categories) {
    if (input.includes(cat) && cat.length > matchLength) {
      bestMatch = cat;
      matchLength = cat.length;
    }
  }

  if (bestMatch) {
    category = bestMatch.charAt(0).toUpperCase() + bestMatch.slice(1);
    emoji = categories[bestMatch].emoji;
    for (let sub of categories[bestMatch].subcategories) {
      if (input.includes(sub)) {
        subcategory = sub.charAt(0).toUpperCase() + sub.slice(1);
        break;
      }
    }
  }

  for (let method in paymentMethods) {
    if (input.includes(method)) {
      paymentMethod = paymentMethods[method];
      break;
    }
  }

  const quantityRegex = /(\d+)\s*(cái|ly|tô|phần|suất|lần|lít)/i;
  const quantityMatch = input.match(quantityRegex);
  if (quantityMatch) {
    quantity = parseInt(quantityMatch[1]);
  }

  if (input.includes('thu') || input.includes('nhận') || input.includes('lương') || input.includes('ứng') || input.includes('hoàn')) {
    type = 'Thu';
    category = 'Thu nhập';
    emoji = '💵';
  }

  return {
    amount,
    category,
    emoji,
    subcategory: subcategory || category,
    paymentMethod,
    quantity,
    type,
    description: text.trim()
  };
}

async function saveToSheet(userId, username, expenseData) {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    const now = new Date();
    const dateStr = now.toLocaleDateString('vi-VN');
    const isoTime = now.toISOString();

    await sheet.addRow({
      'Ngày': dateStr,
      'Danh mục': expenseData.category,
      'Mô tả': expenseData.description,
      'Số tiền': expenseData.amount,
      'Loại': expenseData.type === 'Chi' ? 'expense' : 'income',
      'Link hóa đơn': '',
      'Thời gian': isoTime,
      'Danh mục phụ': expenseData.subcategory,
      'Số lượng': expenseData.quantity,
      'Phương thức thanh toán': expenseData.paymentMethod,
      'Ghi chú': `${username} (${userId})`
    });

    return true;
  } catch (error) {
    console.error('Error saving to sheet:', error);
    return false;
  }
}

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply(`Hello ${ctx.from.first_name}!\nNhập chi thu đi.`);
});

bot.help((ctx) => {
  ctx.reply(`📖 Hướng dẫn:\n\n🔹 Nhập chi tiêu:\n"Xăng xe 500k tk"\n"Phở bò 55k tm"\n\n💳 Thanh toán:\n• tk = Chuyển khoản\n• tm = Tiền mặt`);
});

bot.command('categories', (ctx) => {
  let message = `📋 Danh mục chi tiêu:

🚗 Chi phí xe ô tô: Xăng, Rửa xe, VETC
🍽️ Nhà hàng: Ăn sáng, Ăn trưa, Ăn tối, Café
📦 Giao nhận đồ: Ship đồ, Grab food
🛒 Mua đồ/Dịch vụ: Mua sắm, Spa, Cắt tóc
💰 Chi phí khác: Linh tinh`;
  ctx.reply(message);
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;

  const expense = parseExpense(text);

  if (expense.amount <= 0) {
    return ctx.reply('❌ Không nhận diện được số tiền.\n\n💡 Ví dụ: "Xăng xe 500k tk"');
  }

  const confirmMsg = `✅ Tôi đã nhận thông tin:\n\n${expense.emoji} ${expense.category} \n💰 ${expense.amount.toLocaleString('vi-VN')} ₫\n💳 ${expense.paymentMethod}\n\n⏳ Đang lưu...`;

  const loadingMsg = await ctx.reply(confirmMsg);

  const saved = await saveToSheet(
    ctx.from.id,
    ctx.from.username || ctx.from.first_name,
    expense
  );

  const finalMsg = confirmMsg.replace('⏳ Đang lưu...', '✅ Đã lưu thành công!');

  if (saved) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      finalMsg
    );
  } else {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      '❌ Có lỗi khi lưu. Vui lòng thử lại.'
    );
  }
});

bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('❌ Có lỗi xảy ra. Vui lòng thử lại.');
});

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({
        error: 'Method not allowed',
        message: 'Webhook endpoint is working! Use POST method.',
        timestamp: new Date().toISOString()
      });
    }

    await bot.handleUpdate(req.body);
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
