#!/usr/bin/env node

const axios = require('axios');

const BOT_TOKEN = '8241117179:AAGUWE8QTaQTAeOwTt1Gom8c_41dgrGIvME';

async function getChatId() {
  console.log('📱 Getting Telegram Chat ID...');
  console.log('\nPlease follow these steps:');
  console.log('1. Open Telegram and search for: @CashManicaBot');
  console.log('2. Start a chat with the bot by clicking "Start" or sending /start');
  console.log('3. Send any message to the bot (e.g., "Hello")');
  console.log('4. Press Enter here after sending the message...');
  
  // Wait for user to press enter
  await new Promise(resolve => {
    process.stdin.once('data', resolve);
  });

  try {
    const response = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`);
    const updates = response.data.result;
    
    if (updates.length === 0) {
      console.log('\n❌ No messages found. Please make sure you sent a message to the bot.');
      return;
    }
    
    // Get the most recent message
    const lastUpdate = updates[updates.length - 1];
    const chatId = lastUpdate.message?.chat?.id || lastUpdate.message?.from?.id;
    
    if (chatId) {
      console.log(`\n✅ Chat ID found: ${chatId}`);
      console.log(`\nAdd this to your .env file:`);
      console.log(`TELEGRAM_CHAT_ID=${chatId}`);
      
      // Send a test message
      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: '✅ Connection successful! Your bot is ready to send trading alerts.',
        parse_mode: 'HTML'
      });
      
      console.log('\n✅ Test message sent! Check your Telegram.');
    } else {
      console.log('\n❌ Could not find chat ID. Please try again.');
    }
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.response?.data) {
      console.error('Details:', error.response.data);
    }
  }
}

getChatId().catch(console.error);