'use strict';
const $ = id => document.getElementById(id);
let config, provider, signer, contract, account, token, goal, balance = 0n;
let mode = 'deposit', busy = false, generation = 0, nextTo = null, entries = [];
const fmt = wei => ethers.formatEther(BigInt(wei));
const short = s => s.slice(0, 6) + '…' + s.slice(-4);
function notice(message, kind = '') { $('notice').textContent = message; $('notice').className = 'notice ' + kind; }
function controls() {
  for (const id of ['send', 'save-goal', 'refresh', 'older']) $(id).disabled = !token || busy;
  $('connect').disabled = busy;
  $('disconnect').disabled = busy;
}
async function api(path, options = {}) {
  const response = await fetch('/api/' + path, { ...options, headers: {
    'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...options.headers
  }});
  const data = await response.json();
  if (!response.ok) { if (response.status === 401) reset(); throw Error(data.error || 'Request failed.'); }
  return data;
}
function amountWei(value) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value.trim())) throw Error('Enter a positive ETH amount with no more than 18 decimal places.');
  const amount = ethers.parseEther(value.trim());
  if (amount <= 0n || amount > ethers.MaxUint256) throw Error('Amount is outside the supported range.');
  return amount;
}
function friendly(error) {
  if (error.code === 4001 || error.code === 'ACTION_REJECTED') return 'You cancelled the wallet request. No transaction was submitted by this action.';
  if (error.code === 'INSUFFICIENT_FUNDS') return 'Not enough wallet ETH to cover the amount and network gas fees.';
  return error.shortMessage || error.message || 'Something went wrong. Please try again.';
}
async function action(fn) {
  if (busy) return;
  busy = true; controls();
  try { await fn(); } catch (error) { notice(friendly(error), 'error'); }
  finally { busy = false; controls(); }
}
function renderGoal() {
  $('balance').textContent = token ? fmt(balance) : '—';
  $('goal-name').textContent = goal ? goal.name : 'Your next chapter';
  $('goal-description').textContent = goal ? 'One deposit closer to making it happen.' : 'Set a goal and take the first step.';
  let percentage = goal ? Number(balance * 10000n / BigInt(goal.target_wei)) / 100 : 0;
  percentage = Math.min(100, percentage);
  $('progress-fill').style.width = percentage + '%';
  document.querySelector('.progress-track').setAttribute('aria-valuenow', percentage);
  $('progress-label').textContent = goal ? percentage.toFixed(1) + '% of your goal' : 'No goal yet';
  $('target-label').textContent = goal ? 'Target ' + fmt(goal.target_wei) + ' ETH' : 'Set your target below';
  if (goal) { $('name').value = goal.name; $('target').value = fmt(goal.target_wei); }
}
function renderHistory() {
  const tbody = $('history'); tbody.replaceChildren();
  if (!entries.length) {
    const tr = document.createElement('tr'), td = document.createElement('td');
    td.colSpan = 5; td.className = 'empty';
    td.textContent = token ? 'No activity in the scanned blocks. Add savings or load older activity.' : 'Connect a wallet to view your transactions.';
    tr.append(td); tbody.append(tr);
  }
  for (const entry of entries) {
    const tr = document.createElement('tr');
    for (const text of [entry.kind, (entry.kind === 'Deposit' ? '+ ' : '− ') + fmt(entry.amount_wei) + ' ETH', String(entry.block)]) {
      const td = document.createElement('td'); td.textContent = text; tr.append(td);
    }
    const status = document.createElement('td'), badge = document.createElement('span');
    badge.className = 'status-pill'; badge.textContent = 'Confirmed · ' + entry.confirmations;
    status.append(badge); tr.append(status);
    const hash = document.createElement('td'), link = document.createElement(config.explorer ? 'a' : 'span');
    link.textContent = short(entry.hash); link.title = entry.hash;
    if (config.explorer) { link.href = config.explorer + '/tx/' + entry.hash; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    hash.append(link); tr.append(hash); tbody.append(tr);
  }
  $('older').hidden = nextTo === null;
}
async function refresh(older = false) {
  const version = generation;
  const [saved, chainBalance, history] = await Promise.all([
    api('goal'), api('balance'), api('history' + (older && nextTo !== null ? '?to=' + nextTo : ''))
  ]);
  if (version !== generation) return;
  goal = saved.goal; balance = BigInt(chainBalance.balance_wei);
  entries = older ? entries.concat(history.entries) : history.entries;
  nextTo = history.next_to;
  $('history-range').textContent = 'Scanned blocks ' + history.scanned_from + '–' + history.scanned_to + (nextTo === null ? ' · Beginning of contract history reached' : ' · Older blocks available');
  renderGoal(); renderHistory();
}
function reset() {
  generation++; token = null; account = null; signer = null; contract = null;
  goal = null; balance = 0n; entries = []; nextTo = null;
  $('name').value = ''; $('target').value = ''; $('amount').value = '';
  $('connect').textContent = 'Connect wallet ↗'; $('disconnect').hidden = true;
  $('history-range').textContent = 'Transactions are read from contract events.';
  renderGoal(); renderHistory(); controls();
}
async function ensureNetwork() {
  const id = Number(await window.ethereum.request({ method: 'eth_chainId' }));
  if (id !== config.chainId) throw Error('Switch your wallet to ' + (config.network === 'local' ? 'Localhost 31337' : 'Sepolia') + ' and reconnect.');
}
$('connect').addEventListener('click', () => action(async () => {
  if (token) { await refresh(); return; }
  if (!window.ethereum) throw Error('MetaMask was not found. Install the browser extension, then reload this page.');
  if (!config?.contractAddress) throw Error('The contract is not configured. Follow README to deploy it first.');
  await window.ethereum.request({ method: 'eth_requestAccounts' });
  await ensureNetwork();
  const version = generation;
  provider = new ethers.BrowserProvider(window.ethereum);
  signer = await provider.getSigner();
  const address = await signer.getAddress();
  const artifact = await (await fetch('/static/StudentSavings.json')).json();
  const code = await provider.getCode(config.contractAddress);
  if (code.toLowerCase() !== artifact.deployedBytecode.toLowerCase()) throw Error('No matching savings contract at this address. Check deployment settings.');
  const challenge = await api('auth/challenge', { method: 'POST', body: JSON.stringify({ address }) });
  notice('Approve the sign-in message in your wallet. This does not cost gas.');
  const signature = await signer.signMessage(challenge.message);
  const session = await api('auth/verify', { method: 'POST', body: JSON.stringify({ id: challenge.id, signature }) });
  if (version !== generation) throw Error('Wallet changed during sign-in. Please reconnect.');
  token = session.token; account = address;
  contract = new ethers.Contract(config.contractAddress, artifact.abi, signer);
  $('connect').textContent = short(account); $('disconnect').hidden = false;
  await refresh(); notice('Wallet connected. Set your goal or add to your savings.', 'success');
}));
$('disconnect').addEventListener('click', () => action(async () => {
  try { await api('auth/logout', { method: 'POST', body: '{}' }); } finally { reset(); }
  notice('Signed out of Pocket Goals. You can also disconnect this site in MetaMask.');
}));
$('goal-form').addEventListener('submit', event => { event.preventDefault(); action(async () => {
  const target = amountWei($('target').value), name = $('name').value.trim();
  if (!name || name.length > 60) throw Error('Enter a goal name between 1 and 60 characters.');
  await api('goal', { method: 'PUT', body: JSON.stringify({ name, target_wei: target.toString() }) });
  goal = { name, target_wei: target.toString() }; renderGoal(); notice('Goal saved. Your next step starts here.', 'success');
}); });
for (const choice of ['deposit', 'withdraw']) $(choice + '-tab').addEventListener('click', () => {
  if (busy) return; mode = choice;
  for (const name of ['deposit', 'withdraw']) { $(name + '-tab').classList.toggle('active', name === mode); $(name + '-tab').setAttribute('aria-selected', String(name === mode)); }
  $('send').textContent = mode === 'deposit' ? 'Add to my savings ↗' : 'Withdraw to my wallet ↗';
});
$('money-form').addEventListener('submit', event => { event.preventDefault(); action(async () => {
  const amount = amountWei($('amount').value);
  await ensureNetwork();
  const liveAccounts = await window.ethereum.request({ method: 'eth_accounts' });
  if (!liveAccounts[0] || liveAccounts[0].toLowerCase() !== account.toLowerCase()) throw Error('Wallet account changed. Please reconnect.');
  const version = generation, activeContract = contract;
  if (mode === 'withdraw' && amount > await activeContract.balances(account)) throw Error('Withdrawal exceeds your saved balance.');
  notice('Review and approve the transaction in your wallet.');
  const transaction = mode === 'deposit' ? await activeContract.deposit({ value: amount }) : await activeContract.withdraw(amount);
  if (version === generation) notice('Transaction submitted: ' + transaction.hash + '. Waiting for confirmation…');
  // Keep the submitted hash even when RPC polling times out, so users do not blindly resubmit.
  let receipt;
  try { receipt = await transaction.wait(1, 120000); }
  catch (error) {
    if (error.code === 'TRANSACTION_REPLACED' && !error.cancelled && error.receipt?.status === 1) receipt = error.receipt;
    else throw Error('Check transaction ' + transaction.hash + ' in your wallet before retrying. ' + friendly(error));
  }
  if (!receipt || receipt.status !== 1) throw Error('Transaction did not succeed. Check ' + transaction.hash + ' in your wallet.');
  if (version !== generation) return;
  $('amount').value = '';
  try { await refresh(); notice('Transaction confirmed: ' + receipt.hash, 'success'); }
  catch (_) { notice('Transaction confirmed: ' + receipt.hash + '. History refresh failed; click Refresh. Do not submit it again.', 'success'); }
}); });
$('refresh').addEventListener('click', () => action(async () => { await refresh(); notice('Balance and activity refreshed.', 'success'); }));
$('older').addEventListener('click', () => action(async () => { await refresh(true); }));
if (window.ethereum?.on) {
  window.ethereum.on('accountsChanged', () => { reset(); notice('Wallet account changed. Reconnect to continue.'); });
  window.ethereum.on('chainChanged', () => { reset(); notice('Wallet network changed. Reconnect on the configured test network.'); });
}
(async () => {
  try {
    config = await api('config');
    $('network').textContent = config.network === 'local' ? '● Local test network' : '● Sepolia test network';
    $('contract-label').textContent = config.contractAddress ? 'Contract ' + short(config.contractAddress) + ' · Test ETH only' : 'Contract not deployed · See README';
    if (!config.contractAddress) notice('Setup needed: deploy the contract using the README instructions before connecting a wallet.');
  } catch (error) { notice(friendly(error), 'error'); }
})();
