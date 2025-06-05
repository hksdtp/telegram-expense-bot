const { Telegraf } = require('telegraf');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');
const axios = require('axios');
const fs = require('fs');
const util = require('util');
const stream = require('stream');

const pipeline = util.promisify(stream.pipeline);

// Xác thực Google APIs
const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive'
  ],
});

const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
const drive = google.drive({ version: 'v3', auth: serviceAccountAuth });

// Cấu hình danh mục
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
  'chi phí khác': { emoji: '💰', subcategories: ['khác', 'linh tinh'] },
  'thu nhập': { emoji: '💵', subcategories: ['lương', 'thưởng', 'ứng', 'hoàn'] }
};

const paymentMethods = {
  'tk': 'Chuyển khoản',
  'chuyển khoản': 'Chuyển khoản',
  'banking': 'Chuyển khoản',
  'tm': 'Tiền mặt',
  'tiền mặt': 'Tiền mặt',
  'cash': 'Tiền mặt'
};

// Hàm phân tích chi tiêu cải tiến
function parseExpense(text) {
  const input = text.toLowerCase().trim();
  
  // Regex cải tiến cho số tiền
  const amountRegex = /(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)\s*(k|nghìn|triệu|đ|đồng|d|vnd)?\b/i;
  const amountMatches = [...input.matchAll(amountRegex)];
  
  let amount = 0;
  let amountText = '';
  
  // Tìm số tiền hợp lệ nhất (lớn nhất)
  for (const match of amountMatches) {
    let value = parseFloat(match[1].replace(/\./g, '').replace(/,/g, '.'));
    const unit = match[2] ? match[2].toLowerCase() : '';
    
    if (unit.includes('k') || unit.includes('nghìn')) value *= 1000;
    else if (unit.includes('triệu')) value *= 1000000;
    
    if (value > amount) {
      amount = value;
      amountText = match[0];
    }
  }
  
  // Loại bỏ số tiền khỏi mô tả
  const description = text.replace(amountText, '').trim();

  let category = 'Chi phí khác';
  let emoji = '💰';
  let subcategory = 'Khác';
  let paymentMethod = 'Tiền mặt';
  let quantity = 1;
  let type = 'Chi';

  // Phát hiện loại giao dịch
  const incomeKeywords = ['thu', 'nhận', 'lương', 'ứng', 'hoàn'];
  if (incomeKeywords.some(keyword => input.includes(keyword))) {
    type = 'Thu';
    category = 'Thu nhập';
    emoji = '💵';
  } else {
    // Xác định danh mục
    let bestMatch = '';
    let matchLength = 0;
    
    for (const cat in categories) {
      if (input.includes(cat) && cat.length > matchLength) {
        bestMatch = cat;
        matchLength = cat.length;
      }
    }
    
    if (bestMatch) {
      category = bestMatch.charAt(0).toUpperCase() + bestMatch.slice(1);
      emoji = categories[bestMatch].emoji;
      
      // Xác định danh mục con
      for (const sub of categories[bestMatch].subcategories) {
        if (input.includes(sub)) {
          subcategory = sub.charAt(0).toUpperCase() + sub.slice(1);
          break;
        }
      }
    }
    
    // Xác định phương thức thanh toán
    for (const method in paymentMethods) {
      if (input.includes(method)) {
        paymentMethod = paymentMethods[method];
        break;
      }
    }
  }

  return {
    amount,
    category,
    emoji,
    subcategory,
    paymentMethod,
    quantity,
    type,
    description
  };
}

// Tìm hoặc tạo thư mục theo tháng và năm
async function findOrCreateMonthYearFolder(year, month) {
  try {
    const parentFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    const folderName = `${year}_${month}`;
    
    // Tìm thư mục nếu đã tồn tại
    const searchResponse = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${parentFolderId}' in parents and trashed=false`,
      fields: 'files(id, name)',
      spaces: 'drive'
    });
    
    // Nếu thư mục đã tồn tại, trả về ID
    if (searchResponse.data.files.length > 0) {
      return searchResponse.data.files[0].id;
    }
    
    // Nếu chưa tồn tại, tạo thư mục mới
    const folderMetadata = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId]
    };
    
    const folder = await drive.files.create({
      resource: folderMetadata,
      fields: 'id'
    });
    
    return folder.data.id;
  } catch (error) {
    console.error('Lỗi khi tìm/tạo thư mục:', error);
    // Trả về thư mục gốc nếu có lỗi
    return process.env.GOOGLE_DRIVE_FOLDER_ID;
  }
}

// Upload ảnh lên Google Drive theo tháng/năm
async function uploadImageToDrive(filePath, fileName) {
  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = (now.getMonth() + 1).toString().padStart(2, '0'); // Tháng từ 01-12
    
    // Tìm hoặc tạo thư mục tháng/năm
    const folderId = await findOrCreateMonthYearFolder(year, month);
    
    const response = await drive.files.create({
      requestBody: {
        name: fileName,
        mimeType: 'image/jpeg',
        parents: [folderId],
      },
      media: {
        mimeType: 'image/jpeg',
        body: fs.createReadStream(filePath),
      },
    });

    // Cấp quyền truy cập công khai
    await drive.permissions.create({
      fileId: response.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    });

    // Lấy link chia sẻ
    const result = await drive.files.get({
      fileId: response.data.id,
      fields: 'webViewLink',
    });

    return result.data.webViewLink;
  } catch (error) {
    console.error('Lỗi khi upload ảnh:', error);
    return null;
  } finally {
    // Xóa file tạm
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      console.error('Lỗi khi xóa file tạm:', err);
    }
  }
}

// Lưu dữ liệu vào Google Sheets
async function saveToSheet(userId, username, expenseData, imageUrl = '') {
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
      'Link hóa đơn': imageUrl,
      'Thời gian': isoTime,
      'Danh mục phụ': expenseData.subcategory,
      'Số lượng': expenseData.quantity,
      'Phương thức thanh toán': expenseData.paymentMethod,
      'Ghi chú': `${username} (${userId})`
    });

    return true;
  } catch (error) {
    console.error('Lỗi khi lưu vào sheet:', error);
    return false;
  }
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// Xử lý lệnh /start
bot.start((ctx) => {
  ctx.reply(`👋 Xin chào ${ctx.from.first_name}!\n\n📝 Nhập chi tiêu theo cú pháp:\n"Mô tả [số tiền] [phương thức]\n\nVí dụ: "Phở bò 55k tm" hoặc "Ứng 5 triệu tk"`);
});

// Xử lý lệnh /help
bot.help((ctx) => {
  ctx.reply(`📖 HƯỚNG DẪN SỬ DỤNG:\n\n1. Nhập chi tiêu:\n"Ăn sáng 50k tm"\n"Xăng xe 500k tk"\n\n2. Nhập thu nhập:\n"Lương tháng 15 triệu tk"\n"Hoàn tiền 200k tm"\n\n3. Gửi ảnh hóa đơn kèm chú thích\n\n💳 Phương thức thanh toán:\n• tk = Chuyển khoản\n• tm = Tiền mặt`);
});

// Xử lý lệnh /categories
bot.command('categories', (ctx) => {
  let message = `📋 DANH MỤC CHI TIÊU:\n\n`;
  
  for (const [category, data] of Object.entries(categories)) {
    message += `${data.emoji} ${category.charAt(0).toUpperCase() + category.slice(1)}:\n`;
    message += `• ${data.subcategories.join(', ')}\n\n`;
  }
  
  ctx.reply(message);
});

// Xử lý tin nhắn văn bản
bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;

  const expense = parseExpense(text);

  if (expense.amount <= 0) {
    return ctx.reply('❌ Không nhận diện được số tiền!\n\n💡 Ví dụ: "Phở bò 55k tm" hoặc "Ứng 5 triệu tk"');
  }

  const confirmMsg = `✅ THÔNG TIN GIAO DỊCH:\n\n${expense.emoji} ${expense.category}\n📝 ${expense.description}\n💰 ${expense.amount.toLocaleString('vi-VN')} ₫\n💳 ${expense.paymentMethod}\n\n⏳ Đang lưu...`;

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
      confirmMsg.replace('⏳ Đang lưu...', '✅ ĐÃ LƯU THÀNH CÔNG!')
    );
  } else {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      '❌ LỖI KHI LƯU DỮ LIỆU!'
    );
  }
});

// Xử lý ảnh có chú thích
bot.on('photo', async (ctx) => {
  const caption = ctx.message.caption;
  
  if (!caption) {
    return ctx.reply('⚠️ VUI LÒNG GỬI ẢNH KÈM CHÚ THÍCH!\n\nVí dụ: "Phở bò 55k tm"');
  }

  const expense = parseExpense(caption);
  
  if (expense.amount <= 0) {
    return ctx.reply('❌ KHÔNG NHẬN DIỆN ĐƯỢC SỐ TIỀN TRONG CHÚ THÍCH!');
  }

  // Lấy ảnh chất lượng cao nhất
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const fileId = photo.file_id;
  
  // Tải ảnh về
  const fileUrl = await ctx.telegram.getFileLink(fileId);
  const tempFilePath = `/tmp/temp_${fileId}.jpg`;
  
  try {
    const response = await axios({
      method: 'GET',
      url: fileUrl.href,
      responseType: 'stream'
    });
    
    await pipeline(response.data, fs.createWriteStream(tempFilePath));
    
    const confirmMsg = `✅ THÔNG TIN TỪ ẢNH:\n\n${expense.emoji} ${expense.category}\n📝 ${expense.description}\n💰 ${expense.amount.toLocaleString('vi-VN')} ₫\n💳 ${expense.paymentMethod}\n\n⏳ Đang tải ảnh lên Drive...`;
    const loadingMsg = await ctx.reply(confirmMsg);
    
    // Upload ảnh lên Drive theo tháng/năm
    const imageUrl = await uploadImageToDrive(tempFilePath, `hoa_don_${Date.now()}.jpg`);
    
    if (!imageUrl) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        '❌ LỖI KHI TẢI ẢNH LÊN DRIVE! Đang lưu dữ liệu...'
      );
    }
    
    // Lưu vào sheet
    const saved = await saveToSheet(
      ctx.from.id,
      ctx.from.username || ctx.from.first_name,
      expense,
      imageUrl || ''
    );
    
    if (saved) {
      let successMsg = '✅ ĐÃ LƯU THÀNH CÔNG!\n';
      if (imageUrl) successMsg += `📎 Link ảnh: ${imageUrl}`;
      
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        successMsg
      );
    } else {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        '❌ LỖI KHI LƯU DỮ LIỆU VÀO SHEET!'
      );
    }
  } catch (error) {
    console.error('Lỗi khi xử lý ảnh:', error);
    ctx.reply('❌ CÓ LỖI XẢY RA KHI XỬ LÝ ẢNH!');
  }
});

// Xử lý lỗi
bot.catch((err, ctx) => {
  console.error('Bot lỗi:', err);
  ctx.reply('❌ CÓ LỖI HỆ THỐNG! Vui lòng thử lại sau.');
});

// Xử lý webhook cho Vercel
module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      await bot.handleUpdate(req.body);
      res.status(200).json({ status: 'success' });
    } else {
      res.status(200).json({
        message: 'Webhook endpoint is working!',
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
