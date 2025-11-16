import base64
import json
import logging
import socket
import boto3
from botocore.session import Session

# Configure logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

# VSOCK configuration for KMS requests
KMS_VSOCK_PORT = 8001

def handle_kms_decrypt(ciphertext, aws_credentials):
    try:
        # Extract credentials
        access_key = aws_credentials.get("aws_access_key_id")
        secret_key = aws_credentials.get("aws_secret_access_key")
        token = aws_credentials.get("aws_session_token")

        if not access_key or not secret_key or not token:
            raise ValueError("Incomplete AWS credentials")

        # Create a boto3 session with the provided credentials
        session = Session()
        session.set_config_variable('metadata_service_timeout', 1)
        session.set_config_variable('metadata_service_num_attempts', 1)

        kms_client = session.create_client(
            'kms',
            region_name='us-west-1',
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            aws_session_token=token
        )

        # Decrypt the ciphertext
        response = kms_client.decrypt(CiphertextBlob=base64.b64decode(ciphertext))
        plaintext = base64.b64encode(response["Plaintext"]).decode('utf-8')
        return {"plaintext": plaintext}
    except Exception as e:
        logger.error(f"KMS decrypt error: {str(e)}")
        return {"error": str(e)}

def handle_connection(conn):
    try:
        # Receive length prefix
        length_prefix = conn.recv(4)
        if len(length_prefix) != 4:
            raise ValueError("Failed to read length prefix")
        length = int.from_bytes(length_prefix, byteorder='big')
        logger.debug(f"Expecting KMS request of length: {length}")

        # Receive the request
        data = conn.recv(length).decode('utf-8')
        request = json.loads(data)
        logger.debug(f"Received KMS request: {request}")

        # Process the request
        if request.get("action") == "kms_decrypt":
            response = handle_kms_decrypt(request["ciphertext"], request["aws_credentials"])
        else:
            response = {"error": "Unknown action"}

        # Send response
        response_data = json.dumps(response).encode('utf-8')
        length_prefix = len(response_data).to_bytes(4, byteorder='big')
        conn.send(length_prefix + response_data)
    except Exception as e:
        logger.error(f"KMS proxy connection error: {str(e)}")
    finally:
        conn.close()

def main():
    sock = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    sock.bind((socket.VMADDR_CID_ANY, KMS_VSOCK_PORT))
    sock.listen(1)
    logger.info(f"KMS proxy listening on VSOCK port {KMS_VSOCK_PORT}")

    while True:
        conn, addr = sock.accept()
        logger.debug(f"Accepted KMS request connection from {addr}")
        handle_connection(conn)

if __name__ == "__main__":
    main()
