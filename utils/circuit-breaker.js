const EventEmitter = require('events');

const STATES = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN'
};

class CircuitBreaker extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.failureThreshold = options.failureThreshold || 5;
    this.successThreshold = options.successThreshold || 2;
    this.resetTimeoutMs = options.resetTimeoutMs || 30000;
    this.halfOpenRequests = options.halfOpenRequests || 3;
    
    this.state = STATES.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.halfOpenSuccessCount = 0;
    this.halfOpenRequestCount = 0;
    this.lastFailureTime = null;
    this.resetTimer = null;
    
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      rejectedRequests: 0,
      stateTransitions: 0
    };
  }

  _transitionState(newState) {
    if (this.state !== newState) {
      const oldState = this.state;
      this.state = newState;
      this.metrics.stateTransitions++;
      this.emit('stateChange', { from: oldState, to: newState });
    }
  }

  _resetFailureCount() {
    this.failureCount = 0;
  }

  _incrementFailureCount() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
  }

  _scheduleReset() {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
    }
    this.resetTimer = setTimeout(() => {
      this._transitionState(STATES.HALF_OPEN);
      this.halfOpenRequestCount = 0;
      this.halfOpenSuccessCount = 0;
    }, this.resetTimeoutMs);
  }

  _clearResetTimer() {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }

  async execute(operation) {
    this.metrics.totalRequests++;

    if (this.state === STATES.OPEN) {
      this.metrics.rejectedRequests++;
      const error = new Error('Circuit breaker is OPEN');
      error.code = 'CIRCUIT_OPEN';
      throw error;
    }

    if (this.state === STATES.HALF_OPEN) {
      if (this.halfOpenRequestCount >= this.halfOpenRequests) {
        this.metrics.rejectedRequests++;
        const error = new Error('Circuit breaker half-open request limit exceeded');
        error.code = 'CIRCUIT_HALF_OPEN_LIMIT';
        throw error;
      }
      this.halfOpenRequestCount++;
    }

    try {
      const result = await operation();
      this._onSuccess();
      return result;
    } catch (error) {
      this._onFailure();
      throw error;
    }
  }

  _onSuccess() {
    this.metrics.successfulRequests++;

    if (this.state === STATES.HALF_OPEN) {
      this.halfOpenSuccessCount++;
      if (this.halfOpenSuccessCount >= this.successThreshold) {
        this._transitionState(STATES.CLOSED);
        this._resetFailureCount();
        this._clearResetTimer();
      }
    } else if (this.state === STATES.CLOSED) {
      this._resetFailureCount();
    }
  }

  _onFailure() {
    this.metrics.failedRequests++;

    if (this.state === STATES.HALF_OPEN) {
      this._transitionState(STATES.OPEN);
      this._scheduleReset();
    } else if (this.state === STATES.CLOSED) {
      this._incrementFailureCount();
      if (this.failureCount >= this.failureThreshold) {
        this._transitionState(STATES.OPEN);
        this._scheduleReset();
      }
    }
  }

  getState() {
    return this.state;
  }

  getMetrics() {
    return {
      ...this.metrics,
      currentState: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      halfOpenSuccessCount: this.halfOpenSuccessCount,
      halfOpenRequestCount: this.halfOpenRequestCount,
      lastFailureTime: this.lastFailureTime
    };
  }

  resetMetrics() {
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      rejectedRequests: 0,
      stateTransitions: 0
    };
    this.failureCount = 0;
    this.successCount = 0;
    this.halfOpenSuccessCount = 0;
    this.halfOpenRequestCount = 0;
    this.lastFailureTime = null;
  }

  reset() {
    this._clearResetTimer();
    this._transitionState(STATES.CLOSED);
    this._resetFailureCount();
    this.halfOpenSuccessCount = 0;
    this.halfOpenRequestCount = 0;
    this.lastFailureTime = null;
  }

  forceOpen() {
    this._clearResetTimer();
    this._transitionState(STATES.OPEN);
    this._scheduleReset();
  }

  forceClosed() {
    this._clearResetTimer();
    this._transitionState(STATES.CLOSED);
    this._resetFailureCount();
  }

  destroy() {
    this._clearResetTimer();
    this.removeAllListeners();
  }
}

module.exports = {
  CircuitBreaker,
  STATES
};