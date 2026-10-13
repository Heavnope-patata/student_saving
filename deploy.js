'use strict';
document.getElementById('deploy').addEventListener('click', async () => {
  const button = document.getElementById('deploy'), result = document.getElementById('result');
  button.disabled = true;
  try {
    if (!window.ethereum) throw Error('Install MetaMask and reload this page.');
    const config = await (await fetch('/api/config')).json();
    await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (![31337, 11155111].includes(config.chainId)) throw Error('Unsupported deployment network.');
    const currentChain = Number(await window.ethereum.request({ method: 'eth_chainId' }));
    if (currentChain !== config.chainId) {
      result.textContent = 'Please approve switching to ' + config.network + ' in MetaMask.';
      try {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: '0x' + config.chainId.toString(16) }]
        });
      } catch (switchError) {
        const code = switchError.code ?? switchError.data?.originalError?.code;
        if (code === 4001) throw Error('Network switch cancelled. Click Deploy to try again.');
        if (code === -32002) throw Error('Open MetaMask and complete the pending request.');
        if (code === 4902) throw Error('Add the configured test network in MetaMask, then retry.');
        throw switchError;
      }
    }
    const provider = new ethers.BrowserProvider(window.ethereum);
    const chain = Number((await provider.getNetwork()).chainId);
    if (![31337, 11155111].includes(chain) || chain !== config.chainId) throw Error('Switch MetaMask to configured network ' + config.network + ' first.');
    const artifact = await (await fetch('/static/StudentSavings.json')).json();
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, await provider.getSigner());
    result.textContent = 'Review the deployment transaction in MetaMask.';
    const contract = await factory.deploy();
    const tx = contract.deploymentTransaction();
    result.textContent = 'Deployment submitted: ' + tx.hash + '\nWaiting for confirmation. If this page fails, check this hash before deploying again.';
    const receipt = await tx.wait(1, 120000);
    if (!receipt || receipt.status !== 1) throw Error('Deployment not confirmed. Check the submitted hash in your wallet.');
    result.textContent = 'Deployment confirmed. Copy into .env, then restart Flask:\n\nCONTRACT_ADDRESS=' + await contract.getAddress() + '\nDEPLOYMENT_BLOCK=' + receipt.blockNumber + '\n\nTransaction: ' + tx.hash;
  } catch (error) { result.textContent += '\n\n' + (error.shortMessage || error.message); button.disabled = false; }
});
