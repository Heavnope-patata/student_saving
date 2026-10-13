# Pocket Goals

A savings-goal DApp built with Solidity, MetaMask, ethers.js, Flask, web3.py and SQLite. Users can set a goal, deposit and withdraw test ETH, and view balances, progress and transaction history.

The smart contract manages funds and withdrawal permissions. SQLite stores goals and authentication records. Transactions are signed in MetaMask; the backend does not store private keys.

## Local setup

Requirements: Python 3.11, MetaMask and a Sepolia RPC endpoint. Compiled contract artifacts and the browser library are included; Node.js is not required to run this version.

Run in the project folder using Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Skip the copy command if `.env` already exists. Configure it with your own RPC endpoint:

```dotenv
APP_NETWORK=sepolia
APP_ORIGIN=http://127.0.0.1:5000
RPC_URL=https://sepolia.infura.io/v3/YOUR_API_KEY
CONTRACT_ADDRESS=0x7FBF91b5E084406Dd5805C2638BCef2dB7148b6C
DEPLOYMENT_BLOCK=11907704
```

Start the application:

```powershell
.\.venv\Scripts\python.exe app.py
```

Open http://127.0.0.1:5000 in the browser containing MetaMask. Restart Flask after changing `.env`.

## Usage

1. Connect MetaMask on Sepolia and sign the login message.
2. Save a goal name and target amount in ETH.
3. Deposit test ETH and approve the transaction in MetaMask.
4. Withdraw an amount within your saved balance.
5. Check the updated progress and transaction history.

The tested withdrawal workflow uses a standard MetaMask account. Smart-account execution caused a withdrawal failure during testing; disable Smart account functionality on Sepolia for this workflow.

The configured contract can be reused. To deploy a separate contract, open `/deploy`, approve deployment in MetaMask, update the contract address and deployment block in `.env`, and restart Flask.

## Render deployment

Upload this folder's contents to GitHub and create a Python **Web Service** on Render. Leave Root Directory empty when `app.py` is at the repository root.

Build command:

```text
pip install -r requirements.txt
```

Start command:

```text
waitress-serve --host=0.0.0.0 --port=$PORT --call app:create_app
```

Add the five environment variables shown above in Render. Set `APP_ORIGIN` to the exact assigned HTTPS service URL without a trailing slash. Keep the Sepolia RPC endpoint, contract address and deployment block. The included `.python-version` selects Python 3.11.

SQLite is created automatically. Render Free does not preserve it across restarts, redeployments or idle spin-downs, so goals and sessions can be lost. On-chain balances remain unchanged. For persistent SQLite storage, attach a disk to a paid service at `/var/data` and set `DATABASE_PATH=/var/data/savings.sqlite3`.

## Project structure

| Path | Purpose |
| --- | --- |
| `app.py` | Flask API, authentication, SQLite and blockchain reads |
| `contracts/StudentSavings.sol` | Savings smart contract |
| `templates/` | Application and deployment pages |
| `static/` | Styles, JavaScript, contract artifact and ethers.js |
| `.env.example` | Configuration template |
| `requirements.txt` | Python runtime dependencies |

Use test ETH only. Do not commit `.env`, private keys, `.venv/` or `instance/`. The ethers.js license is included in `static/vendor/ethers-LICENSE.md`.
