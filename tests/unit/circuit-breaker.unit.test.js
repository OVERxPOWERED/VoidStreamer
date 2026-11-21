const CircuitBreaker = require('../../src/services/stream-scraper-service').CircuitBreaker;

describe('CircuitBreaker', () => {
  let circuitBreaker;
  let originalTimers;

  beforeEach(() => {
    jest.useFakeTimers();
    circuitBreaker = new CircuitBreaker({
      failureThreshold: 3,
      successThreshold: 2,
      resetTimeout: 5000
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    circuitBreaker.reset();
  });

  describe('Initial State', () => {
    test('starts in CLOSED state', () => {
      expect(circuitBreaker.getState()).toBe('CLOSED');
    });

    test('getMetrics returns zeroed counters initially', () => {
      const metrics = circuitBreaker.getMetrics();
      expect(metrics).toEqual({
        state: 'CLOSED',
        failures: 0,
        successes: 0,
        rejected: 0,
        lastFailureTime: null,
        lastSuccessTime: null
      });
    });
  });

  describe('CLOSED State - Failure Threshold', () => {
    test('remains CLOSED after failures below threshold', async () => {
      await circuitBreaker.execute(() => Promise.reject(new Error('fail')));
      await circuitBreaker.execute(() => Promise.reject(new Error('fail')));
      
      expect(circuitBreaker.getState()).toBe('CLOSED');
      expect(circuitBreaker.getMetrics().failures).toBe(2);
    });

    test('transitions to OPEN after failureThreshold failures', async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(() => Promise.reject(new Error('fail')));
        } catch (e) {}
      }
      
      expect(circuitBreaker.getState()).toBe('OPEN');
      expect(circuitBreaker.getMetrics().failures).toBe(3);
    });

    test('increments rejected count when OPEN', async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(() => Promise.reject(new Error('fail')));
        } catch (e) {}
      }
      
      try {
        await circuitBreaker.execute(() => Promise.resolve('success'));
      } catch (e) {}
      
      expect(circuitBreaker.getMetrics().rejected).toBe(1);
    });
  });

  describe('OPEN State - Request Rejection', () => {
    beforeEach(async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(() => Promise.reject(new Error('fail')));
        } catch (e) {}
      }
    });

    test('rejects requests immediately when OPEN', async () => {
      await expect(circuitBreaker.execute(() => Promise.resolve('success')))
        .rejects.toThrow('Circuit breaker is OPEN');
    });

    test('does not execute the provided function when OPEN', async () => {
      const fn = jest.fn(() => Promise.resolve('success'));
      
      try {
        await circuitBreaker.execute(fn);
      } catch (e) {}
      
      expect(fn).not.toHaveBeenCalled();
    });

    test('records rejection in metrics', async () => {
      try {
        await circuitBreaker.execute(() => Promise.resolve('success'));
      } catch (e) {}
      
      expect(circuitBreaker.getMetrics().rejected).toBe(1);
    });
  });

  describe('HALF_OPEN State - Reset Timeout Transition', () => {
    beforeEach(async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(() => Promise.reject(new Error('fail')));
        } catch (e) {}
      }
      expect(circuitBreaker.getState()).toBe('OPEN');
    });

    test('transitions to HALF_OPEN after resetTimeout', async () => {
      jest.advanceTimersByTime(5000);
      
      await circuitBreaker.execute(() => Promise.resolve('success'));
      
      expect(circuitBreaker.getState()).toBe('HALF_OPEN');
    });

    test('executes function in HALF_OPEN state', async () => {
      jest.advanceTimersByTime(5000);
      
      const result = await circuitBreaker.execute(() => Promise.resolve('success'));
      
      expect(result).toBe('success');
      expect(circuitBreaker.getState()).toBe('HALF_OPEN');
    });

    test('records success in HALF_OPEN state', async () => {
      jest.advanceTimersByTime(5000);
      
      await circuitBreaker.execute(() => Promise.resolve('success'));
      
      expect(circuitBreaker.getMetrics().successes).toBe(1);
    });
  });

  describe('HALF_OPEN State - Success Threshold to Close', () => {
    beforeEach(async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(() => Promise.reject(new Error('fail')));
        } catch (e) {}
      }
      jest.advanceTimersByTime(5000);
    });

    test('remains HALF_OPEN after successes below threshold', async () => {
      await circuitBreaker.execute(() => Promise.resolve('success'));
      
      expect(circuitBreaker.getState()).toBe('HALF_OPEN');
      expect(circuitBreaker.getMetrics().successes).toBe(1);
    });

    test('transitions to CLOSED after successThreshold consecutive successes', async () => {
      await circuitBreaker.execute(() => Promise.resolve('success'));
      await circuitBreaker.execute(() => Promise.resolve('success'));
      
      expect(circuitBreaker.getState()).toBe('CLOSED');
      expect(circuitBreaker.getMetrics().successes).toBe(2);
    });

    test('resets failure count when transitioning to CLOSED', async () => {
      await circuitBreaker.execute(() => Promise.resolve('success'));
      await circuitBreaker.execute(() => Promise.resolve('success'));
      
      expect(circuitBreaker.getMetrics().failures).toBe(0);
    });
  });

  describe('HALF_OPEN State - Failure Re-opens Circuit', () => {
    beforeEach(async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(() => Promise.reject(new Error('fail')));
        } catch (e) {}
      }
      jest.advanceTimersByTime(5000);
    });

    test('transitions back to OPEN on failure in HALF_OPEN', async () => {
      try {
        await circuitBreaker.execute(() => Promise.reject(new Error('fail')));
      } catch (e) {}
      
      expect(circuitBreaker.getState()).toBe('OPEN');
    });

    test('resets success count on failure in HALF_OPEN', async () => {
      await circuitBreaker.execute(() => Promise.resolve('success'));
      try {
        await circuitBreaker.execute(() => Promise.reject(new Error('fail')));
      } catch (e) {}
      
      expect(circuitBreaker.getMetrics().successes).toBe(0);
    });

    test('records failure in metrics when failing in HALF_OPEN', async () => {
      try {
        await circuitBreaker.execute(() => Promise.reject(new Error('fail')));
      } catch (e) {}
      
      expect(circuitBreaker.getMetrics().failures).toBe(4);
    });
  });

  describe('Metrics Persistence Across State Changes', () => {
    test('maintains metrics through full cycle CLOSED -> OPEN -> HALF_OPEN -> CLOSED', async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(() => Promise.reject(new Error('fail')));
        } catch (e) {}
      }
      
      jest.advanceTimersByTime(5000);
      
      await circuitBreaker.execute(() => Promise.resolve('success'));
      await circuitBreaker.execute(() => Promise.resolve('success'));
      
      const metrics = circuitBreaker.getMetrics();
      expect(metrics.state).toBe('CLOSED');
      expect(metrics.failures).toBe(0);
      expect(metrics.successes).toBe(2);
      expect(metrics.rejected).toBe(0);
    });

    test('tracks lastFailureTime correctly', async () => {
      const beforeTime = Date.now();
      try {
        await circuitBreaker.execute(() => Promise.reject(new Error('fail')));
      } catch (e) {}
      const afterTime = Date.now();
      
      const metrics = circuitBreaker.getMetrics();
      expect(metrics.lastFailureTime).toBeGreaterThanOrEqual(beforeTime);
      expect(metrics.lastFailureTime).toBeLessThanOrEqual(afterTime);
    });

    test('tracks lastSuccessTime correctly', async () => {
      const beforeTime = Date.now();
      await circuitBreaker.execute(() => Promise.resolve('success'));
      const afterTime = Date.now();
      
      const metrics = circuitBreaker.getMetrics();
      expect(metrics.lastSuccessTime).toBeGreaterThanOrEqual(beforeTime);
      expect(metrics.lastSuccessTime).toBeLessThanOrEqual(afterTime);
    });

    test('accumulates rejected count across multiple OPEN periods', async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(() => Promise.reject(new Error('fail')));
        } catch (e) {}
      }
      
      try {
        await circuitBreaker.execute(() => Promise.resolve('success'));
      } catch (e) {}
      
      jest.advanceTimersByTime(5000);
      await circuitBreaker.execute(() => Promise.resolve('success'));
      await circuitBreaker.execute(() => Promise.resolve('success'));
      
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(() => Promise.reject(new Error('fail')));
        } catch (e) {}
      }
      
      try {
        await circuitBreaker.execute(() => Promise.resolve('success'));
      } catch (e) {}
      
      expect(circuitBreaker.getMetrics().rejected).toBe(2);
    });
  });

  describe('Reset Functionality', () => {
    test('reset() clears all state and returns to CLOSED', async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(() => Promise.reject(new Error('fail')));
        } catch (e) {}
      }
      
      jest.advanceTimersByTime(5000);
      await circuitBreaker.execute(() => Promise.resolve('success'));
      
      circuitBreaker.reset();
      
      expect(circuitBreaker.getState()).toBe('CLOSED');
      expect(circuitBreaker.getMetrics()).toEqual({
        state: 'CLOSED',
        failures: 0,
        successes: 0,
        rejected: 0,
        lastFailureTime: null,
        lastSuccessTime: null
      });
    });

    test('reset() allows immediate execution after reset', async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(() => Promise.reject(new Error('fail')));
        } catch (e) {}
      }
      
      circuitBreaker.reset();
      
      const result = await circuitBreaker.execute(() => Promise.resolve('success'));
      expect(result).toBe('success');
    });
  });

  describe('Concurrent Request Handling', () => {
    test('handles concurrent requests in CLOSED state', async () => {
      const promises = Array(10).fill(null).map(() => 
        circuitBreaker.execute(() => Promise.resolve('success'))
      );
      
      const results = await Promise.all(promises);
      
      expect(results).toHaveLength(10);
      expect(results.every(r => r === 'success')).toBe(true);
      expect(circuitBreaker.getState()).toBe('CLOSED');
    });

    test('handles concurrent requests when transitioning to OPEN', async () => {
      const failingFn = () => Promise.reject(new Error('fail'));
      
      const promises = Array(5).fill(null).map(() => 
        circuitBreaker.execute(failingFn).catch(e => e.message)
      );
      
      const results = await Promise.all(promises);
      
      const failures = results.filter(r => r === 'fail').length;
      expect(failures).toBeGreaterThanOrEqual(3);
      expect(circuitBreaker.getState()).toBe('OPEN');
    });

    test('rejects all concurrent requests when OPEN', async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(() => Promise.reject(new Error('fail')));
        } catch (e) {}
      }
      
      const promises = Array(5).fill(null).map(() => 
        circuitBreaker.execute(() => Promise.resolve('success')).catch(e => e.message)
      );
      
      const results = await Promise.all(promises);
      
      expect(results.every(r => r === 'Circuit breaker is OPEN')).toBe(true);
      expect(circuitBreaker.getMetrics().rejected).toBe(5);
    });

    test('handles concurrent requests in HALF_OPEN state', async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(() => Promise.reject(new Error('fail')));
        } catch (e) {}
      }
      
      jest.advanceTimersByTime(5000);
      
      const promises = Array(3).fill(null).map(() => 
        circuitBreaker.execute(() => Promise.resolve('success'))
      );
      
      const results = await Promise.all(promises);
      
      expect(results).toHaveLength(3);
      expect(circuitBreaker.getState()).toBe('CLOSED');
    });
  });

  describe('Edge Cases - Zero Thresholds', () => {
    test('handles failureThreshold of 0 (immediately opens)', async () => {
      const zeroThresholdBreaker = new CircuitBreaker({
        failureThreshold: 0,
        successThreshold: 2,
        resetTimeout: 5000
      });
      
      try {
        await zeroThresholdBreaker.execute(() => Promise.reject(new Error('fail')));
      } catch (e) {}
      
      expect(zeroThresholdBreaker.getState()).toBe('OPEN');
    });

    test('handles successThreshold of 0 (immediately closes from HALF_OPEN)', async () => {
      const zeroSuccessBreaker = new CircuitBreaker({
        failureThreshold: 1,
        successThreshold: 0,
        resetTimeout: 5000
      });
      
      try {
        await zeroSuccessBreaker.execute(() => Promise.reject(new Error('fail')));
      } catch (e) {}
      
      jest.advanceTimersByTime(5000);
      
      await zeroSuccessBreaker.execute(() => Promise.resolve('success'));
      
      expect(zeroSuccessBreaker.getState()).toBe('CLOSED');
    });

    test('handles resetTimeout of 0 (immediate HALF_OPEN transition)', async () => {
      const zeroTimeoutBreaker = new CircuitBreaker({
        failureThreshold: 1,
        successThreshold: 2,
        resetTimeout: 0
      });
      
      try {
        await zeroTimeoutBreaker.execute(() => Promise.reject(new Error('fail')));
      } catch (e) {}
      
      expect(zeroTimeoutBreaker.getState()).toBe('OPEN');
      
      jest.advanceTimersByTime(0);
      
      await zeroTimeoutBreaker.execute(() => Promise.resolve('success'));
      
      expect(zeroTimeoutBreaker.getState()).toBe('HALF_OPEN');
    });
  });

  describe('Error Handling', () => {
    test('propagates errors from executed function in CLOSED state', async () => {
      const error = new Error('test error');
      
      await expect(circuitBreaker.execute(() => Promise.reject(error)))
        .rejects.toThrow('test error');
    });

    test('propagates errors from executed function in HALF_OPEN state', async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(() => Promise.reject(new Error('fail')));
        } catch (e) {}
      }
      
      jest.advanceTimersByTime(5000);
      
      const error = new Error('half-open error');
      
      await expect(circuitBreaker.execute(() => Promise.reject(error)))
        .rejects.toThrow('half-open error');
    });

    test('handles synchronous errors in executed function', async () => {
      await expect(circuitBreaker.execute(() => {
        throw new Error('sync error');
      })).rejects.toThrow('sync error');
    });

    test('handles non-Error rejections', async () => {
      await expect(circuitBreaker.execute(() => Promise.reject('string error')))
        .rejects.toBe('string error');
    });
  });

  describe('State Transition Events', () => {
    test('emits state change events if EventEmitter is mixed in', () => {
      const events = [];
      const originalOn = circuitBreaker.on;
      
      if (typeof circuitBreaker.on === 'function') {
        circuitBreaker.on('stateChange', (from, to) => {
          events.push({ from, to });
        });
        
        return circuitBreaker.execute(() => Promise.reject(new Error('fail')))
          .catch(() => {})
          .then(() => circuitBreaker.execute(() => Promise.reject