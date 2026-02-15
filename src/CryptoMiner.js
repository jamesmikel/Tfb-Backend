// CryptoMiner.js
export class CryptoMiner {
  constructor(data) {
    // Force everything to numbers
    this.userId = String(data.user_id || "unknown");

    this.depositAmount = parseFloat(data.confirmed_deposit  || 0);

    this.startTime = Date.now();
    this.durationMs = parseInt(data.proposedtime || 3600000); // 1 hour default

    this.targetProfit = this.depositAmount * parseFloat(data.proposedpercent || data.ProposedPercent || 0.04);

    this.currentProfit = 0;
    this.totalBalance = this.depositAmount;
    this.profitComplete = false;
    this.withdrawn = false;
    this.finalProfit = 0;
  }
  

  updateProfit() {
    if (this.profitComplete) return;

    const elapsedMs = Date.now() - this.startTime;

    if (elapsedMs >= this.durationMs) {
      this.currentProfit = this.targetProfit;
      this.finalProfit = this.targetProfit;
      this.totalBalance = this.depositAmount + this.targetProfit;
      this.profitComplete = true;
    } else {
      const progress = elapsedMs / this.durationMs;
      let baseProfit = progress * this.targetProfit;

      // Controlled volatility
      const volatility = (Math.random() - 0.5) * 0.25; // -12.5% to +12.5%
      this.currentProfit = baseProfit * (1 + volatility);

      this.currentProfit = Math.max(0, Math.min(this.targetProfit, this.currentProfit));
      this.totalBalance = this.depositAmount + this.currentProfit;
    }
  }

  withdraw() {
    const amount = this.totalBalance;
    this.withdrawn = true;
    return amount;
  }

  getStatus() {
    this.updateProfit();

    const elapsedMs = Date.now() - this.startTime;
    const remainingMs = Math.max(0, this.durationMs - elapsedMs);

    const displayProfit = this.profitComplete ? this.finalProfit : this.currentProfit;
    const displayBalance = this.depositAmount + displayProfit;

    return {
      userId: this.userId,
      proposedpercent: this.targetProfit / this.depositAmount * 100,
      deposit: this.depositAmount.toFixed(2),
      currentProfit: Number(displayProfit).toFixed(6),
      totalBalance: Number(displayBalance).toFixed(6),
      profitPercentage: this.depositAmount > 0 
        ? ((displayProfit / this.depositAmount) * 100).toFixed(2) 
        : "0.00",
      profitComplete: this.profitComplete,
      withdrawn: this.withdrawn,
      remainingMinutes: Math.ceil(remainingMs / 60000),
      canWithdraw: this.profitComplete && !this.withdrawn,
    };
  }
}
