const { Telegraf } = require('telegraf');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);

// Danh mục đầy đủ
const categories = {
  'chi phí xe ô tô': { 
    emoji: '🚗', 
    subcategories: ['xăng', 'rửa xe', 'vetc', 'sửa chữa', 'vé đỗ xe', 'đổ xăng', 'nhiên liệu'] 
  },
  'xăng': { 
    emoji: '⛽', 
    subcategories: ['xăng', 'nhiên liệu', 'đổ xăng'],
    parent: 'Chi phí xe ô tô'
  },
  'rửa xe': { 
    emoji: '🧽', 
    subcategories: ['rửa xe', 'vệ sinh xe'] 
  },
  'vetc': { 
    emoji: '🎫', 
    subcategories: ['vetc', 'thu phí không dừng'] 
  },
  'nhà hàng': { 
    emoji: '🍽️', 
    subcategories: ['ăn sáng', 'ăn trưa', 'ăn tối', 'café'] 
  },
  'ăn sáng': { 
    emoji: '🍳', 
    subcategories: ['phở', 'bánh mì', 'cơm'] 
  },
  'ăn trưa': { 
    emoji: '🍱', 
    subcategories: ['cơm', 'bún', 'phở'] 
  },
  'ăn tối': { 
    emoji: '🍽️', 
    subcategories: ['cơm', 'lẩu', 'nướng'] 
  },
  'café': { 
    emoji: '☕', 
    subcategories: ['cà phê', 'trà', 'nước'] 
  },
  'giao nhận đồ': { 
    emoji: '📦', 
    subcategories: ['giao đồ', 'ship đồ', 'grab food'] 
  },
  'ship đồ': { 
    emoji: '📮', 
    subcategories: ['phí ship', 'giao hàng'] 
  },
  'mua đồ': { 
    emoji: '🛒', 
    subcategories: ['quần áo', 'giày dép', 'mỹ phẩm'] 
  },
  'dịch vụ': { 
    emoji: '🔧', 
    subcategories: ['cắt tóc', 'massage', 'spa'] 
  },
  'chi phí khác': { 
    emoji: '💰', 
    subcategories: ['khác', 'linh tinh'] 
  },
  // Thêm danh mục cho các khoản thu
  'ứng trước': { 
    emoji: '💳', 
    subcategories: ['ứng', 'tạm ứng'] 
  },
  'hoàn tiền': { 
    emoji: '↩️', 
    subcategories: ['hoàn', 'hoàn trả'] 
  }
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
  
  // Regex nhận diện số tiền
  const amountRegex = /(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)\s*(k|đ|vnd|d|ng|nghìn|triệu)?\b/i;
  const amountMatch = input.match(amountRegex);
  
  let amount = 0;
  let category = 'Chi phí khác';
  let emoji = '💰';
  let subcategory = 'Khác';
  let paymentMethod = 'Tiền mặt';
  let quantity = 1;
  let type = 'expense'; // Mặc định là chi tiêu
  
  // Nhận diện số lít xăng
  let fuelQuantity = 1;
  const fuelRegex = /(\d+)\s*(lít|l|lit)\b/i;
  const fuelMatch = input.match(fuelRegex);
  
  if (fuelMatch) {
    fuelQuantity = parseInt(fuelMatch[1]);
  }

  // Xử lý số tiền
  if (amountMatch) {
    let amountStr = amountMatch[1].replace(/[.,]/g, '');
    amount = parseInt(amountStr);
    
    const unit = amountMatch[2] ? amountMatch[2].toLowerCase() : '';
    if (unit === 'k' || unit === 'nghìn' || unit === 'ng') {
      amount *= 1000;
    } else if (unit === 'triệu') {
      amount *= 1000000;
    }
  }
  
  // Xác định loại giao dịch TRƯỚC khi phân loại danh mục
  // Thêm hỗ trợ "ứng" và "hoàn" như thu nhập
  if (input.includes('thu') || input.includes('nhận') || input.includes('lương') || 
      input.includes('ứng') || input.includes('hoàn')) {
    type = 'income';
    emoji = '💵';
    
    // Xác định danh mục cụ thể cho thu nhập
    if (input.includes('ứng')) {
      category = 'Ứng trước';
      emoji = '💳';
    } else if (input.includes('hoàn')) {
      category = 'Hoàn tiền';
      emoji = '↩️';
    } else {
      category = 'Thu nhập';
    }
  }
  
  // Chỉ phân loại danh mục nếu là chi tiêu (expense)
  if (type === 'expense') {
    // Tìm danh mục tốt nhất
    let bestMatch = '';
    let matchLength = 0;
    
    for (let cat in categories) {
      const keywords = [cat, ...categories[cat].subcategories];
      const hasMatch = keywords.some(keyword => input.includes(keyword));
      
      if (hasMatch && cat.length > matchLength) {
        bestMatch = cat;
        matchLength = cat.length;
      }
    }
    
    if (bestMatch) {
      // Ưu tiên sử dụng danh mục cha nếu có
      if (categories[bestMatch].parent) {
        category = categories[bestMatch].parent;
        emoji = categories[category.toLowerCase()]?.emoji || categories[bestMatch].emoji;
      } else {
        category = bestMatch.charAt(0).toUpperCase() + bestMatch.slice(1);
        emoji = categories[bestMatch].emoji;
      }
      
      // Tìm danh mục con phù hợp
      for (let sub of categories[bestMatch].subcategories) {
        if (input.includes(sub)) {
          subcategory = sub.charAt(0).toUpperCase() + sub.slice(1);
          break;
        }
      }
    }
    
    // Xử lý đặc biệt cho trường hợp xăng
    if (input.includes('xăng') || input.includes('đổ xăng')) {
      category = 'Chi phí xe ô tô';
      subcategory = 'Xăng';
      emoji = '⛽';
      
      // Sử dụng số lượng xăng nếu có
      if (fuelMatch) {
        quantity = fuelQuantity;
      }
    }
  }
  
  // Nhận diện phương thức thanh toán (chỉ cho chi tiêu)
  if (type === 'expense') {
    for (let method in paymentMethods) {
      if (input.includes(method)) {
        paymentMethod = paymentMethods[method];
        break;
      }
    }
  }
  
  // Nhận diện số lượng chung
  const quantityRegex = /(\d+)\s*(cái|ly|tô|phần|suất|lần|kg|gói|hộp)\b/i;
  const quantityMatch = input.match(quantityRegex);
  if (quantityMatch) {
    quantity = parseInt(quantityMatch[1]);
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
    const timeISO = now.toISOString();
    
    await sheet.addRow({
      'Ngày': dateStr,
      'Danh mục': expenseData.category,
      'Mô tả': expenseData.description,
      'Số tiền': expenseData.amount,
      'Loại': expenseData.type,
      'Link hóa đơn': '',
      'Thời gian': timeISO,
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
  ctx.reply(`🤖 Chào mừng ${ctx.from.first_name}!\n\n📝 Nhập chi tiêu theo format:\n"Xăng xe 500k tk"\n"Phở bò 55k tm"\n\n💸 Nhập thu nhập:\n"Lương tháng 6 20 triệu"\n"Ứng 5 triệu"\n"Hoàn vé máy bay 1.5 triệu"\n\n💳 Thanh toán: tk = Chuyển khoản, tm = Tiền mặt`);
});

bot.help((ctx) => {
  ctx.reply(`📖 Hướng dẫn:\n\n🔹 Nhập chi tiêu:\n"Xăng xe 500k tk"\n"Phở bò 55k tm"\n\n🔹 Nhập thu nhập:\n"Lương 10 triệu"\n"Ứng 3 triệu"\n"Hoàn vé xe 500k"\n\n💳 Thanh toán (chỉ cho chi tiêu):\n• tk = Chuyển khoản\n• tm = Tiền mặt\n\n🔹 Lệnh:\n/categories - Danh mục`);
});

bot.command('categories', (ctx) => {
  let message = '📋 Danh mục chi tiêu & thu nhập:\n\n';
  message += '💵 Thu nhập:\n• Lương\n• Ứng trước\n• Hoàn tiền\n\n';
  message += '🚗 Chi phí xe ô tô: Xăng, Rửa xe, VETC\n';
  message += '🍽️ Nhà hàng: Ăn sáng, Ăn trưa, Ăn tối, Café\n';
  message += '📦 Giao nhận đồ: Ship đồ, Grab food\n';
  message += '🛒 Mua đồ/Dịch vụ: Mua sắm, Spa, Cắt tóc\n';
  message += '💰 Chi phí khác: Linh tinh\n\n';
  message += '💡 Ví dụ: "Xăng xe 500k tk", "Ứng 5 triệu", "Hoàn tiền vé máy bay 1.5 triệu"';
  ctx.reply(message);
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;
  
  const expense = parseExpense(text);
  
  if (expense.amount <= 0) {
    return ctx.reply('❌ Không nhận diện được số tiền.\n\n💡 Ví dụ: "Xăng xe 500k tk", "Ứng 5 triệu"');
  }
  
  let confirmMsg;
  if (expense.type === 'income') {
    confirmMsg = `✅ Đã phân tích (THU NHẬP):\n\n${expense.emoji} ${expense.category}\n💰 ${expense.amount.toLocaleString('vi-VN')}₫\n\n⏳ Đang lưu...`;
  } else {
    confirmMsg = `✅ Đã phân tích (CHI TIÊU):\n\n${expense.emoji} ${expense.category}\n💰 ${expense.amount.toLocaleString('vi-VN')}₫\n💳 ${expense.paymentMethod}\n\n⏳ Đang lưu...`;
  }
  
  const loadingMsg = await ctx.reply(confirmMsg);
  
  const saved = await saveToSheet(
    ctx.from.id,
    ctx.from.username || ctx.from.first_name,
    expense
  );
  
  if (saved) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      confirmMsg.replace('⏳ Đang lưu...', '✅ Đã lưu thành công!')
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

// Production (Serverless environment)
exports.handler = async (event) => {
  try {
    await bot.handleUpdate(JSON.parse(event.body));
    return { statusCode: 200, body: '' };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: 'Internal Server Error' };
  }
};

// Development (Local environment)
if (process.env.NODE_ENV === 'development') {
  bot.launch();
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
