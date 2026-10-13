"""Student Savings: Flask metadata API and read-only blockchain gateway."""
import hashlib
import json
import os
import re
import secrets
import sqlite3
import time
from functools import wraps
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv
from eth_account import Account
from eth_account.messages import encode_defunct
from eth_keys.exceptions import BadSignature
from flask import Flask, g, jsonify, render_template, request
from web3 import Web3

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / '.env')
UINT256_MAX = 2**256 - 1


def create_app(overrides=None):
    app = Flask(__name__)
    network = os.getenv('APP_NETWORK', 'local')
    if network not in ('local', 'sepolia'):
        raise ValueError('APP_NETWORK must be local or sepolia; mainnet is not supported.')
    deployment = {}
    local_file = ROOT / 'deployment.local.json'
    if network == 'local' and local_file.exists():
        deployment = json.loads(local_file.read_text())
    app.config.update(
        NETWORK=network, CHAIN_ID=31337 if network == 'local' else 11155111,
        RPC_URL=os.getenv('RPC_URL', 'http://127.0.0.1:8545' if network == 'local' else ''),
        CONTRACT_ADDRESS=os.getenv('CONTRACT_ADDRESS') or deployment.get('address', ''),
        DEPLOYMENT_BLOCK=int(os.getenv('DEPLOYMENT_BLOCK') or deployment.get('block', 0)),
        APP_ORIGIN=os.getenv('APP_ORIGIN', 'http://127.0.0.1:5000').rstrip('/'),
        DATABASE=os.getenv('DATABASE_PATH') or str(ROOT / 'instance/savings.sqlite3'),
        MAX_CONTENT_LENGTH=8192,
    )
    if overrides:
        app.config.update(overrides)
    artifact_file = ROOT / 'static/StudentSavings.json'
    artifact = json.loads(artifact_file.read_text()) if artifact_file.exists() else None
    Path(app.config['DATABASE']).parent.mkdir(parents=True, exist_ok=True)

    def db():
        if 'db' not in g:
            g.db = sqlite3.connect(app.config['DATABASE'], timeout=10)
            g.db.row_factory = sqlite3.Row
        return g.db

    with app.app_context():
        db().executescript('''
        CREATE TABLE IF NOT EXISTS goals (
          address TEXT PRIMARY KEY, name TEXT NOT NULL, target_wei TEXT NOT NULL,
          updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS challenges (
          id TEXT PRIMARY KEY, address TEXT NOT NULL, message TEXT NOT NULL,
          expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY, address TEXT NOT NULL, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS rate_limits (ip TEXT NOT NULL, created INTEGER NOT NULL);
        ''')
        db().commit()

    @app.teardown_appcontext
    def close_db(_error=None):
        connection = g.pop('db', None)
        if connection is not None:
            connection.close()

    def error(message, status=400):
        return jsonify(error=message), status

    def body():
        data = request.get_json(silent=True)
        return data if isinstance(data, dict) else {}

    @app.before_request
    def protect_requests():
        # Reject other Host values (including DNS rebinding) and cross-origin writes.
        if request.host != urlparse(app.config['APP_ORIGIN']).netloc:
            return error('Open the app using its configured APP_ORIGIN.', 400)
        if request.method in ('POST', 'PUT', 'DELETE'):
            if request.headers.get('Origin') != app.config['APP_ORIGIN']:
                return error('Request origin is not allowed.', 403)
            if not request.is_json:
                return error('Send application/json.', 415)

    @app.after_request
    def headers(response):
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['Content-Security-Policy'] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
            "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        )
        if request.path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    def authenticated(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            auth = request.headers.get('Authorization', '')
            if not auth.startswith('Bearer '):
                return error('Please connect and sign in with your wallet.', 401)
            digest = hashlib.sha256(auth[7:].encode()).hexdigest()
            row = db().execute('SELECT * FROM sessions WHERE token_hash=? AND expires>?',
                               (digest, int(time.time()))).fetchone()
            if row is None:
                return error('Session expired. Please reconnect your wallet.', 401)
            g.wallet = row['address']
            g.token_hash = digest
            return fn(*args, **kwargs)
        return wrapped

    @app.get('/')
    def index():
        return render_template('index.html')

    @app.get('/deploy')
    def deploy_page():
        return render_template('deploy.html')

    @app.get('/api/config')
    def config():
        return jsonify(network=app.config['NETWORK'], chainId=app.config['CHAIN_ID'],
                       contractAddress=app.config['CONTRACT_ADDRESS'],
                       deploymentBlock=app.config['DEPLOYMENT_BLOCK'],
                       explorer='https://sepolia.etherscan.io' if app.config['NETWORK'] == 'sepolia' else '',
                       artifactReady=artifact is not None)

    @app.post('/api/auth/challenge')
    def challenge():
        account = body().get('address', '')
        if not isinstance(account, str) or not Web3.is_address(account):
            return error('A valid Ethereum wallet address is required.')
        account = Web3.to_checksum_address(account)
        now = int(time.time())
        connection = db()
        connection.execute('BEGIN IMMEDIATE')
        connection.execute('DELETE FROM rate_limits WHERE created<?', (now - 60,))
        count = connection.execute('SELECT COUNT(*) FROM rate_limits WHERE ip=?',
                                   (request.remote_addr,)).fetchone()[0]
        if count >= 20:
            connection.rollback()
            return error('Too many sign-in attempts. Wait a minute.', 429)
        connection.execute('INSERT INTO rate_limits VALUES (?,?)', (request.remote_addr, now))
        connection.execute('DELETE FROM challenges WHERE expires<=?', (now,))
        connection.execute('DELETE FROM sessions WHERE expires<=?', (now,))
        nonce = secrets.token_hex(24)
        expires = now + 300
        message = (f"Student Savings wallet sign-in\nOrigin: {app.config['APP_ORIGIN']}\n"
                   f"Wallet: {account}\nChain ID: {app.config['CHAIN_ID']}\n"
                   f"Nonce: {nonce}\nExpires (Unix seconds): {expires}\n"
                   'Sign in to read and edit your savings goal. This does not transfer funds.')
        connection.execute('INSERT INTO challenges VALUES (?,?,?,?)', (nonce, account, message, expires))
        connection.commit()
        return jsonify(id=nonce, message=message)

    @app.post('/api/auth/verify')
    def verify():
        data = body()
        nonce, signature = data.get('id'), data.get('signature')
        if not isinstance(nonce, str) or not isinstance(signature, str) or len(signature) != 132:
            return error('Invalid signature request.')
        connection = db()
        connection.execute('BEGIN IMMEDIATE')
        row = connection.execute('SELECT * FROM challenges WHERE id=? AND expires>?',
                                 (nonce, int(time.time()))).fetchone()
        if row is None:
            connection.rollback()
            return error('Sign-in request expired or has already been used.', 401)
        try:
            recovered = Account.recover_message(encode_defunct(text=row['message']), signature=signature)
        except (ValueError, TypeError, BadSignature):
            recovered = None
        if recovered != row['address']:
            connection.rollback()
            return error('The signature does not match this wallet.', 401)
        token = secrets.token_urlsafe(32)
        digest = hashlib.sha256(token.encode()).hexdigest()
        connection.execute('DELETE FROM challenges WHERE id=?', (nonce,))
        connection.execute('INSERT INTO sessions VALUES (?,?,?)',
                           (digest, recovered, int(time.time()) + 3600))
        connection.commit()
        return jsonify(token=token, address=recovered)

    @app.post('/api/auth/logout')
    @authenticated
    def logout():
        db().execute('DELETE FROM sessions WHERE token_hash=?', (g.token_hash,))
        db().commit()
        return jsonify(ok=True)

    @app.get('/api/goal')
    @authenticated
    def get_goal():
        row = db().execute('SELECT name,target_wei,updated_at FROM goals WHERE address=?',
                           (g.wallet,)).fetchone()
        return jsonify(goal=dict(row) if row else None)

    @app.put('/api/goal')
    @authenticated
    def save_goal():
        data = body()
        name, target = data.get('name'), data.get('target_wei')
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60 or any(ord(c) < 32 for c in name):
            return error('Goal name must contain 1-60 characters without control characters.')
        if (not isinstance(target, str) or not re.fullmatch(r'[1-9][0-9]{0,77}', target)
                or int(target) > UINT256_MAX):
            return error('Target must be a positive amount in wei within the uint256 range.')
        db().execute('''INSERT INTO goals VALUES (?,?,?,?) ON CONFLICT(address) DO UPDATE SET
                      name=excluded.name,target_wei=excluded.target_wei,updated_at=excluded.updated_at''',
                     (g.wallet, name.strip(), target, int(time.time())))
        db().commit()
        return jsonify(ok=True)

    def chain():
        if not artifact or not app.config['RPC_URL'] or not Web3.is_address(app.config['CONTRACT_ADDRESS']):
            raise RuntimeError('Deploy the contract and configure its address and RPC URL first.')
        web3 = Web3(Web3.HTTPProvider(app.config['RPC_URL'], request_kwargs={'timeout': 8}))
        if web3.eth.chain_id != app.config['CHAIN_ID']:
            raise RuntimeError('The server RPC is connected to the wrong network.')
        address = Web3.to_checksum_address(app.config['CONTRACT_ADDRESS'])
        code = web3.eth.get_code(address)
        if bytes(code).hex() != artifact['deployedBytecode'][2:]:
            raise RuntimeError('The configured address does not contain this StudentSavings contract. Redeploy or check configuration.')
        return web3, web3.eth.contract(address=address, abi=artifact['abi'])

    @app.get('/api/balance')
    @authenticated
    def balance():
        try:
            web3, contract = chain()
            block = web3.eth.block_number
            value = contract.functions.balances(g.wallet).call(block_identifier=block)
            return jsonify(balance_wei=str(value), block=block)
        except RuntimeError as exc:
            return error(str(exc), 503)
        except Exception:
            app.logger.warning('Blockchain balance lookup failed.')
            return error('Blockchain service unavailable. Please retry shortly.', 503)

    @app.get('/api/history')
    @authenticated
    def history():
        cursor = request.args.get('to')
        if cursor is not None and (not cursor.isdecimal() or len(cursor) > 16):
            return error('Invalid history cursor.')
        try:
            web3, contract = chain()
            latest = web3.eth.block_number
            end = min(int(cursor), latest) if cursor is not None else latest
            start = max(app.config['DEPLOYMENT_BLOCK'], end - 1999)
            entries = []
            if start <= end:
                for event, kind in ((contract.events.Deposited, 'Deposit'), (contract.events.Withdrawn, 'Withdrawal')):
                    for log in event().get_logs(from_block=start, to_block=end,
                                                argument_filters={'account': g.wallet}):
                        entries.append(dict(kind=kind, amount_wei=str(log['args']['amount']),
                                            balance_wei=str(log['args']['balance']),
                                            hash=Web3.to_hex(log['transactionHash']),
                                            block=log['blockNumber'], log_index=log['logIndex'],
                                            confirmations=latest - log['blockNumber'] + 1))
            entries.sort(key=lambda item: (item['block'], item['log_index']), reverse=True)
            more = start > app.config['DEPLOYMENT_BLOCK']
            return jsonify(entries=entries, scanned_from=start, scanned_to=end,
                           next_to=start - 1 if more else None, latest_block=latest)
        except RuntimeError as exc:
            return error(str(exc), 503)
        except Exception:
            app.logger.warning('Blockchain history lookup failed.')
            return error('Transaction history is temporarily unavailable. Please retry.', 503)

    return app


if __name__ == '__main__':
    create_app().run(host='127.0.0.1', port=5000, debug=False)
