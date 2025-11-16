import logging
from aiogram import types
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.context import FSMContext
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton
from aiogram.filters import Command
from core.stellar import build_and_submit_transaction, has_trustline, parse_asset, load_account_async
from stellar_sdk import Asset, PathPaymentStrictReceive, ChangeTrust, Payment, Keypair
from stellar_sdk.exceptions import NotFoundError
from handlers.copy_trading import copy_trade_menu_command
from services.streaming import StreamingService
from services.trade_services import perform_buy, perform_sell
from services.referrals import log_xlm_volume, calculate_referral_shares, export_unpaid_rewards, daily_payout
import secrets
import os
import asyncio
from datetime import datetime

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

class BuySellStates(StatesGroup):
    waiting_for_asset = State()
    waiting_for_amount = State()

class WithdrawStates(StatesGroup):
    waiting_for_asset = State()
    waiting_for_address = State()
    waiting_for_amount = State()
    waiting_for_confirmation = State()

class ReferralStates(StatesGroup):
    referral_code = State()

class TrustlineStates(StatesGroup):
    waiting_for_asset_to_add = State()
    waiting_for_asset_to_remove = State()

welcome_text = """
Welcome to @Stellar_Photon_bot!
Trade assets on Stellar with ease.
Use the buttons below to buy, sell, check balance, or manage copy trading.
"""

main_menu_keyboard = InlineKeyboardMarkup(inline_keyboard=[
    [InlineKeyboardButton(text="Buy", callback_data="buy"),
     InlineKeyboardButton(text="Sell", callback_data="sell")],
    [InlineKeyboardButton(text="Check Balance", callback_data="balance"),
     InlineKeyboardButton(text="Copy Trading", callback_data="copy_trading")],
    [InlineKeyboardButton(text="Withdraw", callback_data="withdraw"),
     InlineKeyboardButton(text="Referrals", callback_data="wallets")],
    [InlineKeyboardButton(text="Add Trustline", callback_data="add_trustline"),
     InlineKeyboardButton(text="Remove Trustline", callback_data="remove_trustline")],
    [InlineKeyboardButton(text="Help/FAQ", callback_data="help_faq")]
])

async def generate_welcome_message(telegram_id, app_context):
    try:
        public_key = await app_context.load_public_key(telegram_id)
        try:
            account = await load_account_async(public_key, app_context)
            xlm_balance = float(next((b["balance"] for b in account["balances"] if b["asset_type"] == "native"), "0"))
            welcome_text = (
                f"*Welcome to @Stellar_Photon_bot!*\n"
                f"Jump into Stellar trading with ease!\n\n"
                f"*Your Wallet:* `{public_key}`\n"
                f"*XLM Balance:* {xlm_balance:.7f}\n\n"
                f"Trade issued assets and Soroban SAC, stream copy trade wallets, and earn rewards with referrals.\n"
                f"Use the buttons below to get started.\n\n"
                f"*New Users* Fund your wallet with XLM to trade. See /help for wallet and security tips.\n"
                f"*Note:* Soroban supported for copy trades!"
            )
        except NotFoundError:
            welcome_text = (
                f"*Welcome to @Stellar_Photon_bot!*\n"
                f"Jump into Stellar trading with ease!\n\n"
                f"*Your Wallet:* `{public_key}`\n"
                f"*XLM Balance:* Not funded\n\n"
                f"Your wallet needs XLM to start trading. Send XLM to your public key from an exchange "
                f"(e.g., Coinbase, Kraken, Lobstr).\n\n"
                f"Trade issued assets and Soroban SAC, stream copy trade wallets, and earn rewards with referrals.\n"
                f"Use the buttons below to get started. See /help for wallet and security tips.\n"
                f"*Note:* Soroban supported for copy trades!"
            )
    except Exception as e:
        logger.error(f"Error fetching wallet info for welcome message: {str(e)}", exc_info=True)
        welcome_text = (
            f"*Welcome to @Stellar_Photon_bot!*\n"
            f"Jump into Stellar trading with ease!\n\n"
            f"Trade issued assets and Soroban SAC, stream copy trade wallets, and earn rewards with referrals.\n"
            f"Use the buttons below to get started.\n\n"
            f"*New Users* Fund your wallet with XLM to trade. See /help for wallet and security tips.\n"
            f"*Note:* Soroban supported for copy trades!"
        )
    return welcome_text

async def start_command(message: types.Message, app_context, streaming_service: StreamingService, state: FSMContext):
    telegram_id = message.from_user.id
    logger.info(f"Start command: from_user.id={telegram_id}, chat_id={message.chat.id}, is_group={message.chat.type == 'group'}")
    chat_id = message.chat.id
    
    text = message.text.strip()
    if text.startswith('/start'):
        parts = text.split(maxsplit=1)
        if len(parts) > 1:
            args = parts[1]
            if 'ref-' in args:
                referral_code = args.split('ref-')[1]
                await state.update_data(referral_code=referral_code)
                logger.info(f"Stored referral code {referral_code} in state for user {telegram_id}")
    
    async with app_context.db_pool_nitro.acquire() as conn:
        exists = await conn.fetchval("SELECT telegram_id FROM users WHERE telegram_id = $1", telegram_id)
    if not exists and message.from_user.is_bot:
        logger.info(f"Ignoring start command from bot itself for telegram_id {telegram_id}")
        return
    elif not exists:
        await message.reply("You’re not registered yet. Use /register to get started.")
    else:
        welcome_text = await generate_welcome_message(telegram_id, app_context)
        await message.reply(welcome_text, reply_markup=main_menu_keyboard, parse_mode="Markdown")

async def cancel_command(message: types.Message, state: FSMContext):
    await state.clear()
    await message.reply("Action cancelled. Use /start to begin again.")

async def register_command(message: types.Message, app_context, state: FSMContext):
    telegram_id = message.from_user.id
    logger.info(f"Register command: from_user.id={telegram_id}, chat_id={message.chat.id}, is_group={message.chat.type == 'group'}")
    chat_id = message.chat.id
    
    async with app_context.db_pool_nitro.acquire() as conn:
        exists = await conn.fetchval("SELECT telegram_id FROM users WHERE telegram_id = $1", telegram_id)
        if exists:
            await message.reply("You’re already registered!")
            return
    
    data = await state.get_data()
    referral_code = data.get('referral_code')
    logger.info(f"Referral code retrieved from state: {referral_code}")
    
    if not referral_code:
        await message.reply("Do you have a referral code? If yes, please enter it now (e.g., dPVDzjTUaWM). If not, reply with 'none'.")
        await state.set_state(ReferralStates.referral_code)
        return
    
    referrer_id = None
    if referral_code and referral_code.lower() != 'none':
        async with app_context.db_pool_copytrading.acquire() as conn:
            referrer_id = await conn.fetchval(
                "SELECT telegram_id FROM users WHERE referral_code = $1",
                referral_code
            )
        if referrer_id:
            logger.info(f"Found referrer {referrer_id} for referral_code {referral_code}")
        else:
            logger.warning(f"No referrer found for referral code {referral_code}")
            await message.reply("Invalid referral code. Proceeding without a referrer.")
    
    bot_id = app_context.bot.id
    if telegram_id == bot_id:
        logger.error(f"Attempted registration with bot ID {telegram_id}, rejecting")
        await message.reply("Bot cannot register itself!")
        return
    
    try:
        response = await app_context.generate_keypair(telegram_id)
        public_key = response["public_key"]
        recovery_secret = response["recovery_secret"]
        
        referral_code_value = secrets.token_urlsafe(8)
        async with app_context.db_pool_copytrading.acquire() as conn:
            await conn.execute(
                "INSERT INTO users (telegram_id, referral_code, public_key) VALUES ($1, $2, $3)",
                telegram_id, referral_code_value, public_key
            )
            if referrer_id:
                await conn.execute(
                    "INSERT INTO referrals (referee_id, referrer_id) VALUES ($1, $2)",
                    telegram_id, referrer_id
                )
        
        await state.clear()
        
        backup_message = (
            f"Registered! Your public key: `{public_key}`\n\n"
            f"**Your Recovery Mnemonic (SAVE THIS NOW):**\n"
            f"`{recovery_secret}`\n\n"
            f"**WARNING**: This is the *ONLY TIME* you will see this mnemonic. "
            f"Write it down or store it securely offline (e.g., paper, USB). "
            f"If you lose it, you will lose access to your wallet and funds. "
            f"Delete this message after saving it!\n\n"
            f"DO NOT screenshot or share it—your device or Telegram could be compromised. "
            f"**Bot Wallet**: This wallet is for trading with @Stellar_Photon_bot. "
            f"Fund it with only the XLM you plan to trade to keep your other wallets safe.\n\n"
            f"**Recovery**: To recover your wallet, import the 24-word mnemonic into a Stellar wallet "
            f"like Xbull, Lobstr, or any wallet supporting 24-word Stellar mnemonics.\n\n"
            f"Click the button below to confirm you’ve saved it."
        )
        confirmation_keyboard = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="I’ve Saved It", callback_data=f"seed_saved_{telegram_id}")]
        ])
        await message.reply(backup_message, parse_mode="Markdown", reply_markup=confirmation_keyboard)
        logger.info("Registration message sent successfully")
    except Exception as e:
        logger.error(f"Registration failed: {str(e)}", exc_info=True)
        await message.reply(f"Registration failed: {str(e)}")

async def process_referral_code(message: types.Message, state: FSMContext, app_context):
    referral_code = message.text.strip()
    telegram_id = message.from_user.id
    chat_id = message.chat.id
    
    if referral_code.lower() == 'none':
        referral_code = None
    
    referrer_id = None
    if referral_code:
        async with app_context.db_pool_copytrading.acquire() as conn:
            referrer_id = await conn.fetchval(
                "SELECT telegram_id FROM users WHERE referral_code = $1",
                referral_code
            )
        if referrer_id:
            logger.info(f"Found referrer {referrer_id} for referral_code {referral_code}")
        else:
            logger.warning(f"No referrer found for referral_code {referral_code}")
            await message.reply("Invalid referral code. Proceeding without a referrer.")
    
    bot_id = app_context.bot.id
    if telegram_id == bot_id:
        logger.error(f"Attempted registration with bot ID {telegram_id}, rejecting")
        await message.reply("Bot cannot register itself!")
        await state.clear()
        return
    
    try:
        response = await app_context.generate_keypair(telegram_id)
        public_key = response["public_key"]
        recovery_secret = response["recovery_secret"]
        
        referral_code_value = secrets.token_urlsafe(8)
        async with app_context.db_pool_copytrading.acquire() as conn:
            await conn.execute(
                "INSERT INTO users (telegram_id, referral_code, public_key) VALUES ($1, $2, $3)",
                telegram_id, referral_code_value, public_key
            )
            if referrer_id:
                await conn.execute(
                    "INSERT INTO referrals (referee_id, referrer_id) VALUES ($1, $2)",
                    telegram_id, referrer_id
                )
        
        await state.clear()
        
        backup_message = (
            f"Registered! Your public key: `{public_key}`\n\n"
            f"**Your Recovery Mnemonic (SAVE THIS NOW):**\n"
            f"`{recovery_secret}`\n\n"
            f"**WARNING**: This is the *ONLY TIME* you will see this mnemonic. "
            f"Write it down or store it securely offline (e.g., paper, USB). "
            f"If you lose it, you will lose access to your wallet and funds. "
            f"Delete this message after saving it!\n\n"
            f"DO NOT screenshot or share it—your device or Telegram could be compromised. "
            f"**Bot Wallet**: This wallet is for trading with @Stellar_Photon_bot. "
            f"Fund it with only the XLM you plan to trade to keep your other wallets safe.\n\n"
            f"**Recovery**: To recover your wallet, import the 24-word mnemonic into a Stellar wallet "
            f"like Xbull, Lobstr, or any wallet supporting 24-word Stellar mnemonics.\n\n"
            f"Click the button below to confirm you’ve saved it."
        )
        confirmation_keyboard = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="I’ve Saved It", callback_data=f"seed_saved_{telegram_id}")]
        ])
        await message.reply(backup_message, parse_mode="Markdown", reply_markup=confirmation_keyboard)
        logger.info("Registration message sent successfully")
    except Exception as e:
        logger.error(f"Registration failed: {str(e)}", exc_info=True)
        await message.reply(f"Registration failed: {str(e)}")
        await state.clear()

async def confirm_seed_saved(callback: types.CallbackQuery, app_context):
    telegram_id = callback.from_user.id
    logger.info(f"Received callback: {callback.data}")
    try:
        if f"seed_saved_{telegram_id}" in callback.data:
            logger.info(f"Confirmed seed saved for user {telegram_id}")
            await callback.message.delete()
            await callback.message.answer(
                "Great! The Message with your secret seed has been deleted, and your wallet is ready. Use /start to begin trading.",
                parse_mode="Markdown"
            )
            asyncio.create_task(send_reminder(callback.message.bot, telegram_id))
    except Exception as e:
        logger.error(f"Error in confirm_seed_saved: {str(e)}", exc_info=True)
    await callback.answer()

async def send_reminder(bot, telegram_id):
    await asyncio.sleep(30)
    try:
        await bot.send_message(telegram_id, "Reminder: Ensure your seed is securely stored offline!")
        logger.info(f"Sent reminder to user {telegram_id}")
    except Exception as e:
        logger.error(f"Failed to send reminder to user {telegram_id}: {str(e)}")

async def unregister_command(message: types.Message, app_context, streaming_service: StreamingService):
    telegram_id = message.from_user.id
    logger.info(f"Unregister command: from_user.id={telegram_id}, chat_id={message.chat.id}, is_group={message.chat.type == 'group'}")
    chat_id = message.chat.id
    async with app_context.db_pool_nitro.acquire() as conn:
        existing = await conn.fetchval("SELECT telegram_id FROM users WHERE telegram_id = $1", telegram_id)
        if not existing:
            await message.reply("No wallet registered.")
            return
        warning_message = (
            "Warning: Unregistering will delete your wallet keypair and associated data. "
            "Since backups are only provided during registration, ensure you’ve saved your recovery secret elsewhere if you have funds.\n\n"
            "Are you sure you want to proceed?"
        )
        confirm_keyboard = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="Yes, Unregister", callback_data=f"confirm_unregister_{telegram_id}"),
             InlineKeyboardButton(text="No, Cancel", callback_data=f"cancel_unregister_{telegram_id}")]
        ])
        await message.reply(warning_message, reply_markup=confirm_keyboard)

async def confirm_unregister(callback: types.CallbackQuery, app_context, streaming_service: StreamingService):
    telegram_id = callback.from_user.id
    chat_id = callback.message.chat.id
    logger.info(f"Confirm unregister: telegram_id={telegram_id}, chat_id={chat_id}")
    try:
        if f"confirm_unregister_{telegram_id}" in callback.data:
            logger.info(f"Proceeding with unregister for user {telegram_id}")
            async with app_context.db_pool_nitro.acquire() as conn:
                await conn.execute("DELETE FROM users WHERE telegram_id = $1", telegram_id)
                result = await conn.fetchval("SELECT telegram_id FROM users WHERE telegram_id = $1", telegram_id)
                if result:
                    logger.error(f"Deletion failed: User {telegram_id} still exists in NITRO database")
                else:
                    logger.info(f"User {telegram_id} successfully deleted from NITRO database")

            async with app_context.db_pool_copytrading.acquire() as conn:
                await conn.execute("DELETE FROM trades WHERE user_id = $1", telegram_id)
                result = await conn.fetchval("SELECT user_id FROM trades WHERE user_id = $1", telegram_id)
                if result:
                    logger.error(f"Deletion failed: User {telegram_id} still exists in Copy Trading trades table")
                else:
                    logger.info(f"User {telegram_id} successfully deleted from Copy Trading trades table")

                await conn.execute("DELETE FROM rewards WHERE user_id = $1", telegram_id)
                result = await conn.fetchval("SELECT user_id FROM rewards WHERE user_id = $1", telegram_id)
                if result:
                    logger.error(f"Deletion failed: User {telegram_id} still exists in Copy Trading rewards table")
                else:
                    logger.info(f"User {telegram_id} successfully deleted from Copy Trading rewards table")

                await conn.execute("DELETE FROM copy_trading WHERE user_id = $1", telegram_id)
                result = await conn.fetchval("SELECT user_id FROM copy_trading WHERE user_id = $1", telegram_id)
                if result:
                    logger.error(f"Deletion failed: User {telegram_id} still exists in Copy Trading copy_trading table")
                else:
                    logger.info(f"User {telegram_id} successfully deleted from Copy Trading copy_trading table")

                await conn.execute("DELETE FROM referrals WHERE referee_id = $1 OR referrer_id = $1", telegram_id)
                result = await conn.fetchval("SELECT referee_id FROM referrals WHERE referee_id = $1", telegram_id)
                if result:
                    logger.error(f"Deletion failed: User {telegram_id} still exists in Copy Trading referrals table as referee")
                else:
                    logger.info(f"User {telegram_id} successfully deleted from Copy Trading referrals table as referee")
                result = await conn.fetchval("SELECT referrer_id FROM referrals WHERE referrer_id = $1", telegram_id)
                if result:
                    logger.error(f"Deletion failed: User {telegram_id} still exists in Copy Trading referrals table as referrer")
                else:
                    logger.info(f"User {telegram_id} successfully deleted from Copy Trading referrals table as referrer")

                await conn.execute("DELETE FROM users WHERE telegram_id = $1", telegram_id)
                result = await conn.fetchval("SELECT telegram_id FROM users WHERE telegram_id = $1", telegram_id)
                if result:
                    logger.error(f"Deletion failed: User {telegram_id} still exists in Copy Trading users table")
                else:
                    logger.info(f"User {telegram_id} successfully deleted from Copy Trading users table")

            await streaming_service.stop_streaming(chat_id)
            await callback.message.edit_text("Unregistered successfully. To re-register, use /start.")
        elif f"cancel_unregister_{telegram_id}" in callback.data:
            await callback.message.edit_text("Unregistration cancelled. Your wallet remains active.")
    except Exception as e:
        logger.error(f"Error in confirm_unregister: {str(e)}", exc_info=True)
        await callback.message.edit_text(f"Error during unregistration: {str(e)}")
    await callback.answer()

async def process_buy_sell(callback: types.CallbackQuery, state: FSMContext):
    logger.info(f"Processing buy/sell callback: {callback.data}")
    action = callback.data
    await state.update_data(action=action)
    await callback.message.reply(f"Please enter the asset code and issuer for {action} in the format: code:issuer")
    await state.set_state(BuySellStates.waiting_for_asset)
    await callback.answer()

async def process_asset(message: types.Message, state: FSMContext):
    asset_input = message.text.strip()
    try:
        code, issuer = asset_input.split(':')
        if not issuer.startswith('G') or len(issuer) != 56:
            raise ValueError("Issuer must be a valid Stellar public key")
        await state.update_data(asset_code=code, asset_issuer=issuer)
        await message.reply("Enter the amount to buy/sell:")
        await state.set_state(BuySellStates.waiting_for_amount)
    except ValueError as e:
        logger.error(f"Invalid asset format: {str(e)}", exc_info=True)
        await message.reply(f"Invalid format: {str(e)}. Use: code:issuer")

async def process_amount(message: types.Message, state: FSMContext, app_context):
    try:
        data = await state.get_data()
        action = data['action']
        asset_code = data['asset_code']
        asset_issuer = data['asset_issuer']
        amount = float(message.text)
        if amount <= 0:
            raise ValueError("Amount must be positive")
        
        if action == 'buy':
            response, actual_xlm_spent, actual_amount_received = await perform_buy(
                message.from_user.id, app_context.db_pool_nitro, asset_code, asset_issuer, amount, app_context
            )
            await log_xlm_volume(message.from_user.id, actual_xlm_spent, response['hash'], app_context.db_pool_copytrading)
            async with app_context.db_pool_copytrading.acquire() as conn:
                has_referrer = await conn.fetchval(
                    "SELECT referrer_id FROM referrals WHERE referee_id = $1", message.from_user.id
                )
            fee = actual_xlm_spent * (0.009 if has_referrer else 0.01)
            logger.info(f"Calculated fee for user {message.from_user.id}: {fee:.7f} XLM (has_referrer: {has_referrer})")
            await calculate_referral_shares(app_context.db_pool_copytrading, message.from_user.id, fee)
            await message.reply(f"Buy successful. Bought {actual_amount_received:.7f} {asset_code} for {actual_xlm_spent:.7f} XLM\nTx Hash: {response['hash']}")
        elif action == 'sell':
            response, actual_xlm_received, actual_amount_sent = await perform_sell(
                message.from_user.id, app_context.db_pool_nitro, asset_code, asset_issuer, amount, app_context
            )
            await log_xlm_volume(message.from_user.id, actual_xlm_received, response['hash'], app_context.db_pool_copytrading)
            async with app_context.db_pool_copytrading.acquire() as conn:
                has_referrer = await conn.fetchval(
                    "SELECT referrer_id FROM referrals WHERE referee_id = $1", message.from_user.id
                )
            fee = actual_xlm_received * (0.009 if has_referrer else 0.01)
            logger.info(f"Calculated fee for user {message.from_user.id}: {fee:.7f} XLM (has_referrer: {has_referrer})")
            await calculate_referral_shares(app_context.db_pool_copytrading, message.from_user.id, fee)
            await message.reply(f"Sell successful. Sold {actual_amount_sent:.7f} {asset_code} for {actual_xlm_received:.7f} XLM\nTx Hash: {response['hash']}")
        else:
            raise ValueError("Invalid action")
    except Exception as e:
        logger.error(f"Error in {action}: {str(e)}", exc_info=True)
        error_msg = str(e) if str(e) else "An unexpected error occurred during the transaction."
        await message.reply(f"Error: {error_msg}")
    finally:
        await state.clear()
        await message.reply(welcome_text, reply_markup=main_menu_keyboard, parse_mode="Markdown")

async def process_balance(callback: types.CallbackQuery, app_context):
    try:
        public_key = await app_context.load_public_key(callback.from_user.id)
        try:
            account = await load_account_async(public_key, app_context)

            # Fetch balances, excluding XLM
            balance_lines = [
                f"`{b['asset_code']}:{b['asset_issuer'] if b.get('asset_issuer') else 'Unknown'}`: {b['balance']}"
                for b in account["balances"]
                if b['asset_type'] != 'native'
            ]
            xlm_balance = float(next((b["balance"] for b in account["balances"] if b["asset_type"] == "native"), "0"))

            # Calculate XLM usage
            xlm_liabilities = float(next((b["selling_liabilities"] for b in account["balances"] if b["asset_type"] == "native"), "0"))
            subentry_count = account["subentry_count"]
            num_sponsoring = account.get("num_sponsoring", 0)
            num_sponsored = account.get("num_sponsored", 0)
            trustlines = [b for b in account["balances"] if b["asset_type"] != "native"]
            num_trustlines = len(trustlines)
            base_reserve = 2.0
            subentry_reserve = (subentry_count + num_sponsoring - num_sponsored) * 0.5
            minimum_reserve = base_reserve + subentry_reserve
            available_xlm = max(xlm_balance - xlm_liabilities - minimum_reserve, 0)

            # Identify zero-balance trustlines, cap at 5 for display
            zero_balance_trustlines = [
                f"{b['asset_code']}:{b['asset_issuer'] if b.get('asset_issuer') else 'Unknown'}"
                for b in trustlines
                if float(b["balance"]) == 0
            ]
            if zero_balance_trustlines:
                display_trustlines = zero_balance_trustlines[:5]
                remaining = len(zero_balance_trustlines) - len(display_trustlines)
                zero_balance_note = (
                    f"\n\n*Note*: You have {len(zero_balance_trustlines)} trustlines with 0 balance, reserving {len(zero_balance_trustlines) * 0.5:.1f} XLM. "
                    f"Remove them to free up XLM:\n- " + "\n- ".join(display_trustlines)
                )
                if remaining > 0:
                    zero_balance_note += f"\n(and {remaining} more)"
                zero_balance_note += f"\nUse /removetrust to remove unused trustlines."
            else:
                zero_balance_note = ""

            # Build XLM breakdown
            xlm_breakdown = (
                f"XLM Breakdown:\n"
                f"- Total: {xlm_balance:.7f} XLM\n"
                f"- Available: {available_xlm:.7f} XLM\n"
                f"- Reserved: {minimum_reserve:.7f} XLM\n"
                f"  - Base: {base_reserve:.1f} XLM\n"
                f"  - Trustlines ({num_trustlines}): {num_trustlines * 0.5:.1f} XLM\n"
                f"  - Other Subentries: {(subentry_count - num_trustlines + num_sponsoring - num_sponsored) * 0.5:.1f} XLM"
            )
            if xlm_liabilities > 0:
                xlm_breakdown += f"\n- Liabilities (Offers): {xlm_liabilities:.7f} XLM"

            # Construct message without header
            max_message_length = 4096
            header = f"Your wallet: `{public_key}`\nYour balances:\n"
            footer = "\n\n*Click to copy code:issuer for buy/sell.*"
            if available_xlm < 0.1:
                footer += f"\n\nYour available XLM is low ({available_xlm:.7f} XLM). Please fund your account to perform transactions."
            footer += zero_balance_note

            # Build content_text without the header
            balance_text = "\n".join(balance_lines)
            content_text = f"{xlm_breakdown}\n\nOther Assets:\n{balance_text}" if balance_lines else f"{xlm_breakdown}"

            available_length = max_message_length - len(header) - len(footer)
            messages = []
            current_message = header
            lines = content_text.split("\n")

            for line in lines:
                if len(current_message) + len(line) + 1 > max_message_length - len(footer):
                    current_message += footer
                    messages.append(current_message)
                    current_message = header
                current_message += line + "\n"

            if current_message != header:
                current_message += footer
                messages.append(current_message)

            for i, msg in enumerate(messages):
                if len(messages) > 1:
                    msg = f"Page {i+1}/{len(messages)}\n{msg}"
                await callback.message.reply(msg, parse_mode="Markdown")
        except NotFoundError:
            await callback.message.reply(
                f"Your wallet: `{public_key}`\n"
                f"Your account isn’t funded yet. To activate it, send XLM to your public key from an exchange or wallet (e.g., Coinbase, Kraken, Lobstr).",
                parse_mode="Markdown"
            )
    except Exception as e:
        logger.error(f"Error fetching balance: {str(e)}", exc_info=True)
        await callback.message.reply(f"Error fetching balance: {str(e)}")
    await callback.answer()

async def process_register_callback(callback: types.CallbackQuery, app_context, state: FSMContext):
    await register_command(callback.message, app_context, state)
    await callback.answer()

async def process_copy_trading_callback(callback: types.CallbackQuery, app_context, streaming_service: StreamingService):
    user_id = callback.from_user.id
    await copy_trade_menu_command(callback.message, streaming_service, user_id=user_id, app_context=app_context)
    await callback.answer()

async def process_withdraw(callback: types.CallbackQuery, state: FSMContext):
    await callback.message.reply("Please specify the asset you want to withdraw (e.g., XLM or USDC:issuer_address).")
    await state.set_state(WithdrawStates.waiting_for_asset)
    await callback.answer()

async def process_withdraw_asset(message: types.Message, state: FSMContext):
    asset_input = message.text.strip()
    if asset_input.lower() == "xlm":
        asset = Asset.native()
    else:
        try:
            code, issuer = asset_input.split(':')
            Keypair.from_public_key(issuer)
            asset = Asset(code, issuer)
        except:
            await message.reply("Invalid asset format. Use 'XLM' or 'code:issuer'")
            return
    await state.update_data(asset=asset)
    await message.reply("Please enter the destination address.")
    await state.set_state(WithdrawStates.waiting_for_address)

async def process_withdraw_address(message: types.Message, state: FSMContext):
    address = message.text.strip()
    try:
        Keypair.from_public_key(address)
    except:
        await message.reply("Invalid Stellar public key.")
        return
    await state.update_data(address=address)
    await message.reply("Please enter the amount to withdraw.")
    await state.set_state(WithdrawStates.waiting_for_amount)

async def process_withdraw_amount(message: types.Message, state: FSMContext):
    try:
        amount = float(message.text)
        if amount <= 0:
            raise ValueError("Amount must be positive")
    except ValueError as e:
        await message.reply(f"Invalid amount: {str(e)}")
        return
    data = await state.get_data()
    asset = data['asset']
    address = data['address']
    await state.update_data(amount=amount)
    asset_str = "XLM" if asset.is_native() else f"{asset.code}:{asset.issuer}"
    confirmation_text = f"Please confirm the withdrawal:\nAsset: {asset_str}\nAmount: {amount}\nDestination: {address}"
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="Confirm", callback_data="confirm_withdraw"),
         InlineKeyboardButton(text="Cancel", callback_data="cancel_withdraw")]
    ])
    await message.reply(confirmation_text, reply_markup=keyboard)
    await state.set_state(WithdrawStates.waiting_for_confirmation)

async def process_withdraw_confirmation(callback: types.CallbackQuery, state: FSMContext, app_context):
    if callback.data == "confirm_withdraw":
        data = await state.get_data()
        asset = data['asset']
        amount = data['amount']
        destination = data['address']
        try:
            from services.trade_services import perform_withdraw
            response = await perform_withdraw(callback.from_user.id, app_context.db_pool_nitro, asset, amount, destination, app_context)
            await callback.message.reply(f"Withdrawal successful. Tx Hash: {response['hash']}")
        except Exception as e:
            await callback.message.reply(f"Withdrawal failed: {str(e)}")
    else:
        await callback.message.reply("Withdrawal cancelled.")
    await state.clear()
    await callback.answer()

async def export_rewards_command(message: types.Message, app_context):
    telegram_id = message.from_user.id
    admin_id = os.getenv("ADMIN_TELEGRAM_ID")
    if str(telegram_id) != admin_id:
        await message.reply("You are not authorized to use this command.")
        return
    
    output_file = f"referral_rewards_export_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.csv"
    try:
        exported_file_path, total_payout, payout_list = await export_unpaid_rewards(app_context.db_pool_nitro, app_context.db_pool_copytrading, output_file)
        if exported_file_path:
            await message.reply(f"Referral rewards exported to {exported_file_path}")
        else:
            await message.reply("No unpaid rewards to export.")
    except Exception as e:
        logger.error(f"Error exporting unpaid rewards: {str(e)}", exc_info=True)
        await message.reply("An error occurred while exporting unpaid rewards. Please try again later.")

async def manual_payout_command(message: types.Message, app_context):
    telegram_id = message.from_user.id
    admin_id = os.getenv("ADMIN_TELEGRAM_ID")
    if str(telegram_id) != admin_id:
        await message.reply("You are not authorized to use this command.")
        return
    chat_id = message.chat.id
    await daily_payout(app_context.db_pool_nitro, app_context.db_pool_copytrading, app_context.bot, chat_id, app_context)

async def help_faq_command(message: types.Message):
    faq_text = (
        "*Photon Bot Help & FAQ*\n\n"
        "*What is @Stellar_Photon_bot?*\n"
        "Your gateway to trading on the Stellar network! Buy, sell, manage assets, follow top traders with copy trading, "
        "and earn rewards by inviting friends.\n\n"
        "*How do I start?*\n"
        "Use /start to check your wallet or begin registration. You’ll get a dedicated wallet for bot trading.\n\n"
        "*What can I do?*\n"
        "- *Buy/Sell*: Trade assets like USDC, SHX, ETH (use buttons after /start).\n"
        "- *Check Balance*: View your XLM and asset balances, includes reserve calculation and net available XLM.\n"
        "- *Copy Trading*: Streams transactions from any G-address wallet with Horizon AIOHTTP and copies the trade. Multiplier, fixed-amount and slippage settings supported per copied wallet.\n"
        "- *Withdraw*: Send XLM or assets to another Stellar address.\n"
        "- *Referrals*: Invite friends with your referral code to earn rewards.\n"
        "- *Trustlines*: Add (/addtrust) or remove (/removetrust) assets to trade.\n"
        "- *Help*: Use /help for this guide.\n\n"
        "*How do I fund my wallet?*\n"
        "Send XLM to your wallet’s public key from an exchange (e.g., Coinbase, Kraken, Lobstr). "
        "Fund only what you plan to trade to keep your main wallets safe.\n\n"
        "*Do i manually have to add trustlines for copy-trading or buy/sell?*\n"
        "No, the bot will automatically add trustlines for you when you perform a buy/sell or copy-trade.\n\n"
        "*How do I recover my wallet?*\n"
        "During registration, you receive a 24-word mnemonic. Store it offline (e.g., paper, USB). "
        "To recover, import it into a Stellar wallet like Xbull or Lobstr.\n\n"
        "*Is my wallet secure?*\n"
        "Your wallet is generated in a secure, isolated environment with industry-standard encryption. "
        "Your funds are safe as long as you keep your mnemonic private and delete the registration message after saving it.\n\n"
        "*Tips*:\n"
        "- Never share your mnemonic.\n"
        "- Use /removetrust to free up XLM from unused trustlines.\n"
        "- Check /help anytime for guidance.\n\n"
        "*What Soroban functions are supported?*:\n"
        "So far can copy trades from AQUA and Soroswap Routers, has a fallback to SDEX if Soroban copytrade fails. "
        "More functions will be added in the future, for now only issued assets with SAC contracts and copy trading only, no direct buy/sell.\n\n"
        "*Need more help?*\n"
        "Message @Stellar_Photon_bot support in Telegram."
    )
    await message.reply(faq_text, parse_mode="Markdown")

async def help_faq_callback(callback: types.CallbackQuery):
    faq_text = (
        "*Photon Bot Help & FAQ*\n\n"
        "*What is @Stellar_Photon_bot?*\n"
        "Your gateway to trading on the Stellar network! Buy, sell, manage assets, follow top traders with copy trading, "
        "and earn rewards by inviting friends.\n\n"
        "*How do I start?*\n"
        "Use /start to check your wallet or begin registration. You’ll get a dedicated wallet for bot trading.\n\n"
        "*What can I do?*\n"
        "- *Buy/Sell*: Trade assets like USDC, SHX, ETH (use buttons after /start).\n"
        "- *Check Balance*: View your XLM and asset balances, includes reserve calculation and net available XLM.\n"
        "- *Copy Trading*: Streams transactions from any G-address wallet with Horizon AIOHTTP and copies the trade. Multiplier, fixed-amount and slippage settings supported per copied wallet.\n"
        "- *Withdraw*: Send XLM or assets to another Stellar address.\n"
        "- *Referrals*: Invite friends with your referral code to earn rewards.\n"
        "- *Trustlines*: Add (/addtrust) or remove (/removetrust) assets to trade.\n"
        "- *Help*: Use /help for this guide.\n\n"
        "*How do I fund my wallet?*\n"
        "Send XLM to your wallet’s public key from an exchange (e.g., Coinbase, Kraken, Lobstr). "
        "Fund only what you plan to trade to keep your main wallets safe.\n\n"
        "*Do i manually have to add trustlines for copy-trading or buy/sell?*\n"
        "No, the bot will automatically add trustlines for you when you perform a buy/sell or copy-trade.\n\n"
        "*How do I recover my wallet?*\n"
        "During registration, you receive a 24-word mnemonic. Store it offline (e.g., paper, USB). "
        "To recover, import it into a Stellar wallet like Xbull or Lobstr.\n\n"
        "*Is my wallet secure?*\n"
        "Your wallet is generated in a secure, isolated environment with industry-standard encryption. "
        "Your funds are safe as long as you keep your mnemonic private and delete the registration message after saving it.\n\n"
        "*Tips*:\n"
        "- Never share your mnemonic.\n"
        "- Use /removetrust to free up XLM from unused trustlines.\n"
        "- Check /help anytime for guidance.\n\n"
        "*What Soroban functions are supported?*:\n"
        "So far can copy trades from AQUA and Soroswap Routers, has a fallback to SDEX if Soroban copytrade fails. "
        "More functions will be added in the future, for now only issued assets with SAC contracts and copy trading only, no direct buy/sell.\n\n"
        "*Need more help?*\n"
        "Message @Stellar_Photon_bot support in Telegram."
    )
    await callback.message.reply(faq_text, parse_mode="Markdown")
    await callback.answer()

async def process_add_trustline(callback: types.CallbackQuery, state: FSMContext):
    await callback.message.reply("Please enter the asset to add trustline for in the format: code:issuer")
    await state.set_state(TrustlineStates.waiting_for_asset_to_add)
    await callback.answer()

async def process_remove_trustline(callback: types.CallbackQuery, state: FSMContext):
    await callback.message.reply("Please enter the asset to remove trustline for in the format: code:issuer")
    await state.set_state(TrustlineStates.waiting_for_asset_to_remove)
    await callback.answer()

async def add_trust_command(message: types.Message, state: FSMContext):
    await message.reply("Please enter the asset to add trustline for in the format: code:issuer")
    await state.set_state(TrustlineStates.waiting_for_asset_to_add)

async def remove_trust_command(message: types.Message, state: FSMContext):
    await message.reply("Please enter the asset to remove trustline for in the format: code:issuer")
    await state.set_state(TrustlineStates.waiting_for_asset_to_remove)

async def process_add_trustline_asset(message: types.Message, state: FSMContext, app_context):
    asset_input = message.text.strip()
    try:
        code, issuer = asset_input.split(':')
        if not issuer.startswith('G') or len(issuer) != 56:
            raise ValueError("Issuer must be a valid Stellar public key")
        
        from services.trade_services import perform_add_trustline
        response = await perform_add_trustline(message.from_user.id, app_context.db_pool_nitro, code, issuer, app_context)
        await message.reply(f"Trustline added successfully for {code}:{issuer}. Tx Hash: {response['hash']}")
    except Exception as e:
        logger.error(f"Error adding trustline: {str(e)}", exc_info=True)
        await message.reply(f"Error adding trustline: {str(e)}")
    finally:
        await state.clear()
        await message.reply(welcome_text, reply_markup=main_menu_keyboard, parse_mode="Markdown")

async def process_remove_trustline_asset(message: types.Message, state: FSMContext, app_context):
    asset_input = message.text.strip()
    try:
        code, issuer = asset_input.split(':')
        if not issuer.startswith('G') or len(issuer) != 56:
            raise ValueError("Issuer must be a valid Stellar public key")
        
        from services.trade_services import perform_remove_trustline
        response = await perform_remove_trustline(message.from_user.id, app_context.db_pool_nitro, code, issuer, app_context)
        await message.reply(f"Trustline removed successfully for {code}:{issuer}. Tx Hash: {response['hash']}")
    except Exception as e:
        logger.error(f"Error removing trustline: {str(e)}", exc_info=True)
        await message.reply(f"Error removing trustline: {str(e)}")
    finally:
        await state.clear()
        await message.reply(welcome_text, reply_markup=main_menu_keyboard, parse_mode="Markdown")

def register_main_handlers(dp, app_context, streaming_service):
    async def start_handler(message: types.Message, state: FSMContext):
        await start_command(message, app_context, streaming_service, state)
    dp.message.register(start_handler, Command("start"))
    
    dp.message.register(cancel_command, Command("cancel"))
    
    async def register_handler(message: types.Message, state: FSMContext):
        await register_command(message, app_context, state)
    dp.message.register(register_handler, Command("register"))
    
    dp.callback_query.register(process_buy_sell, lambda c: c.data in ["buy", "sell"])
    dp.message.register(process_asset, BuySellStates.waiting_for_asset)
    
    async def amount_handler(message: types.Message, state: FSMContext):
        await process_amount(message, state, app_context)
    dp.message.register(amount_handler, BuySellStates.waiting_for_amount)
    
    async def balance_handler(callback: types.CallbackQuery):
        await process_balance(callback, app_context)
    dp.callback_query.register(balance_handler, lambda c: c.data == "balance")
    
    async def register_callback_handler(callback: types.CallbackQuery, state: FSMContext):
        await process_register_callback(callback, app_context, state)
    dp.callback_query.register(register_callback_handler, lambda c: c.data == "register")
    
    async def copy_trading_handler(callback: types.CallbackQuery):
        await process_copy_trading_callback(callback, app_context, streaming_service)
    dp.callback_query.register(copy_trading_handler, lambda c: c.data == "copy_trading")
    
    async def unregister_handler(message: types.Message):
        await unregister_command(message, app_context, streaming_service)
    dp.message.register(unregister_handler, Command("unregister"))

    dp.callback_query.register(process_withdraw, lambda c: c.data == "withdraw")
    dp.message.register(process_withdraw_asset, WithdrawStates.waiting_for_asset)
    dp.message.register(process_withdraw_address, WithdrawStates.waiting_for_address)
    dp.message.register(process_withdraw_amount, WithdrawStates.waiting_for_amount)
    async def withdraw_confirmation_handler(callback: types.CallbackQuery, state: FSMContext):
        await process_withdraw_confirmation(callback, state, app_context)
    dp.callback_query.register(withdraw_confirmation_handler, WithdrawStates.waiting_for_confirmation)

    async def seed_saved_wrapper(callback: types.CallbackQuery):
        return await confirm_seed_saved(callback, app_context)
    dp.callback_query.register(
        seed_saved_wrapper,
        lambda c: c.data.startswith("seed_saved_")
    )

    async def unregister_wrapper(callback: types.CallbackQuery):
        return await confirm_unregister(callback, app_context, streaming_service)
    dp.callback_query.register(
        unregister_wrapper,
        lambda c: c.data.startswith(("confirm_unregister_", "cancel_unregister_"))
    )

    async def export_handler(message: types.Message):
        await export_rewards_command(message, app_context)
    dp.message.register(export_handler, Command("export_rewards"))

    async def referral_code_handler(message: types.Message, state: FSMContext):
        await process_referral_code(message, state, app_context)
    dp.message.register(referral_code_handler, ReferralStates.referral_code)

    async def manual_payout_handler(message: types.Message):
        await manual_payout_command(message, app_context)
    dp.message.register(manual_payout_handler, Command("manual_payout"))

    dp.message.register(help_faq_command, Command("help"))
    dp.callback_query.register(help_faq_callback, lambda c: c.data == "help_faq")
    
    dp.callback_query.register(process_add_trustline, lambda c: c.data == "add_trustline")
    dp.callback_query.register(process_remove_trustline, lambda c: c.data == "remove_trustline")
    
    dp.message.register(add_trust_command, Command("addtrust"))
    dp.message.register(remove_trust_command, Command("removetrust"))
    
    async def add_trustline_asset_handler(message: types.Message, state: FSMContext):
        await process_add_trustline_asset(message, state, app_context)
    dp.message.register(add_trustline_asset_handler, TrustlineStates.waiting_for_asset_to_add)
    
    async def remove_trustline_asset_handler(message: types.Message, state: FSMContext):
        await process_remove_trustline_asset(message, state, app_context)
    dp.message.register(remove_trustline_asset_handler, TrustlineStates.waiting_for_asset_to_remove)
