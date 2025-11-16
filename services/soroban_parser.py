# services/soroban_parser.py
import logging
import time
from stellar_sdk import TransactionEnvelope, Network
from stellar_sdk.operation import InvokeHostFunction
from stellar_sdk.xdr import HostFunction, HostFunctionType, InvokeContractArgs, SCVal, SCValType, Uint64

logger = logging.getLogger(__name__)

# Define supported routers and their swap functions
SUPPORTED_ROUTERS = {
    "6033b4250e704e314fb064973d185db922cae0bd272ba5bff19aac570f12ac2f": {  # AQUA
        "swap_chained": {
            "sender_arg": 0,       # Index of sender address to replace
            "recipient_arg": 0,    # Index of recipient address (same as sender for AQUA)
            "deadline_arg": None,  # No deadline argument to update
            "amount_in_arg": 3,    # Index of amount_in in args
            "amount_out_min_arg": 4  # Index of amount_out_min in args
        }
    },
    "0dd5c710ea6a4a23b32207fd130eadf9c9ce899f4308e93e4ffe53fbaf108a04": {  # Soroswap
        "swap_exact_tokens_for_tokens": {
            "sender_arg": None,    # No sender argument to replace
            "recipient_arg": 3,    # Index of 'to' address
            "deadline_arg": 4,     # Index of deadline in args
            "amount_in_arg": 0,    # Index of amount_in in args
            "amount_out_min_arg": 1  # Index of amount_out_min in args
        }
    }
    # Add more routers as needed, e.g., Phoenix, Blend, etc.
}

async def parse_soroban_transaction(tx, wallet, chat_id, telegram_id, app_context):
    """Parse a transaction for Soroban InvokeHostFunction operations, filtering for supported swaps."""
    if "successful" not in tx or not tx["successful"]:
        logger.info(f"Transaction {tx['hash']} not successful, skipping.")
        return None

    tx_envelope = TransactionEnvelope.from_xdr(
        tx["envelope_xdr"],
        network_passphrase=Network.PUBLIC_NETWORK_PASSPHRASE
    )
    operations = tx_envelope.transaction.operations
    soroban_ops = []

    for op in operations:
        if not isinstance(op, InvokeHostFunction):
            logger.info(f"Skipping non-InvokeHostFunction operation: {op.__class__.__name__}")
            continue

        op_source = op.source or tx["source_account"]
        if op_source != wallet:
            logger.info(f"Soroban op source {op_source} does not match wallet {wallet}, skipping.")
            continue

        if op.host_function.type != HostFunctionType.HOST_FUNCTION_TYPE_INVOKE_CONTRACT:
            logger.info(f"Skipping non-contract invocation: {op.host_function.type}")
            continue

        # Extract contract ID and function name
        contract_id = op.host_function.invoke_contract.contract_address.contract_id.hash.hex()
        function_name = op.host_function.invoke_contract.function_name.sc_symbol.decode()

        # Check if the contract and function are supported
        if contract_id not in SUPPORTED_ROUTERS:
            logger.info(f"Unsupported router contract: {contract_id}")
            continue

        if function_name not in SUPPORTED_ROUTERS[contract_id]:
            logger.info(f"Unsupported function on contract {contract_id}: {function_name}")
            continue

        # Extract original arguments
        args = op.host_function.invoke_contract.args

        # Preprocess arguments based on router config
        router_config = SUPPORTED_ROUTERS[contract_id][function_name]

        # Update deadline if applicable
        if router_config["deadline_arg"] is not None:
            new_deadline = SCVal(
                type=SCValType.SCV_U64,
                u64=Uint64(int(time.time()) + 300)  # 5 minutes from now
            )
            args[router_config["deadline_arg"]] = new_deadline
            logger.info(f"Updated deadline for {contract_id}.{function_name} to {int(time.time()) + 300}")

        # Rebuild the HostFunction with updated arguments
        new_host_function = HostFunction(
            type=HostFunctionType.HOST_FUNCTION_TYPE_INVOKE_CONTRACT,
            invoke_contract=InvokeContractArgs(
                contract_address=op.host_function.invoke_contract.contract_address,
                function_name=op.host_function.invoke_contract.function_name,
                args=args
            )
        )

        # Prepare the operation details for copying
        soroban_ops.append({
            "contract_id": contract_id,
            "function_name": function_name,
            "args": args,  # Pass SCVal objects directly
            "auth": op.auth,  # Pass raw auth objects
            "original_host_function": new_host_function,
            "original_auth": op.auth,
            "amount_in_arg": router_config["amount_in_arg"],
            "amount_out_min_arg": router_config["amount_out_min_arg"],
            "recipient_arg": router_config["recipient_arg"],
            "sender_arg": router_config["sender_arg"]
        })

        # Log stringified args for readability
        arg_strings = [str(arg) for arg in args]
        logger.info(f"Detected Soroban op: {contract_id}.{function_name}({arg_strings}) from {wallet}")

    if soroban_ops:
        # Construct a minimal message
        message = (
            f"Incoming Soroban tx from {wallet[-5:]}\n"
            f"Tx: {tx['hash'][:8]}..."
        )
        await app_context.bot.send_message(chat_id, message)
        return soroban_ops
    return None