```javascript
#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const HEALTH_CHECK_SERVICE = require('../src/services/health-check-service');
const QUERY_CACHE_SERVICE = require('../src/services/query-cache-service');
const STREAM_DOMAIN_SERVICE = require('../src/services/stream-domain-service');

const REQUIRED_ENV_VARS = [
  'NODE_ENV',
  'PORT',
  'DATABASE_URL',
  'REDIS_URL',
  'TMDB_API_KEY',
  'TRAKT_CLIENT_ID',
  'TRAKT_CLIENT_SECRET',
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'LOG_LEVEL',
  'RATE_LIMIT_WINDOW_MS',
  'RATE_LIMIT_MAX_REQUESTS',
  'CACHE_TTL_SECONDS',
  'STREAM_TIMEOUT_MS',
  'HEALTH_CHECK_INTERVAL_MS',
  'METRICS_ENABLED',
  'TELEMETRY_ENDPOINT'
];

class ProductionVerification {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || `http://localhost:${process.env.PORT || 3000}`;
    this.timeout = options.timeout || 5000;
    this.results = [];
    this.startTime = Date.now();
  }

  async runAll() {
    console.log('🔍 Starting Production Deployment Verification\n');
    
    await this.step1_ConfigValidation();
    await this.step2_HealthCheck();
    await this.step3_StreamSearch();
    await this.step4_StreamResolution();
    await this.step5_CacheMetrics();
    await this.step6_TelemetryEvents();

    this.printSummary();
    this.writeJsonReport();

    const allPassed = this.results.every(r => r.status === 'pass');
    process.exit(allPassed ? 0 : 1);
  }

  async step1_ConfigValidation() {
    const stepStart = Date.now();
    const missing = [];
    const present = [];

    for (const envVar of REQUIRED_ENV_VARS) {
      if (process.env[envVar]) {
        present.push(envVar);
      } else {
        missing.push(envVar);
      }
    }

    const duration = Date.now() - stepStart;
    const status = missing.length === 0 ? 'pass' : 'fail';
    
    this.results.push({
      name: 'Config Validation',
      status,
      duration,
      details: {
        required: REQUIRED_ENV_VARS.length,
        present: present.length,
        missing,
        presentVars: present
      }
    });

    this.logStep('Config Validation', status, duration, missing.length === 0 
      ? 'All required environment variables present' 
      : `Missing: ${missing.join(', ')}`);
  }

  async step2_HealthCheck() {
    const stepStart = Date.now();
    
    try {
      const health = await HEALTH_CHECK_SERVICE.performFullCheck();
      const duration = Date.now() - stepStart;
      
      const allHealthy = health.status === 'healthy' && 
        Object.values(health.subsystems).every(s => s.status === 'healthy');
      
      this.results.push({
        name: 'Health Check',
        status: allHealthy ? 'pass' : 'fail',
        duration,
        details: {
          overall: health.status,
          subsystems: health.subsystems,
          timestamp: health.timestamp
        }
      });

      this.logStep('Health Check', allHealthy ? 'pass' : 'fail', duration, 
        allHealthy ? 'All subsystems healthy' : `Degraded: ${JSON.stringify(health.subsystems)}`);
    } catch (error) {
      const duration = Date.now() - stepStart;
      this.results.push({
        name: 'Health Check',
        status: 'fail',
        duration,
        details: { error: error.message, stack: error.stack }
      });
      this.logStep('Health Check', 'fail', duration, `Error: ${error.message}`);
    }
  }

  async step3_StreamSearch() {
    const stepStart = Date.now();
    const searchTimeout = 2000;
    
    try {
      const query = 'The Matrix';
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), searchTimeout);
      
      const results = await STREAM_DOMAIN_SERVICE.searchStreams(query, { 
        signal: controller.signal,
        limit: 5 
      });
      
      clearTimeout(timeoutId);
      const duration = Date.now() - stepStart;
      
      const hasResults = results && results.length > 0;
      const withinTimeout = duration <= searchTimeout;
      
      this.results.push({
        name: 'Stream Search',
        status: (hasResults && withinTimeout) ? 'pass' : 'fail',
        duration,
        details: {
          query,
          resultCount: results?.length || 0,
          withinTimeout,
          timeoutMs: searchTimeout,
          sampleResults: results?.slice(0, 3).map(r => ({ 
            title: r.title, 
            source: r.source,
            quality: r.quality 
          }))
        }
      });

      this.logStep('Stream Search', (hasResults && withinTimeout) ? 'pass' : 'fail', duration,
        hasResults ? `Found ${results.length} results in ${duration}ms` : 'No results returned');
    } catch (error) {
      const duration = Date.now() - stepStart;
      const isTimeout = error.name === 'AbortError' || error.code === 'ETIMEDOUT';
      
      this.results.push({
        name: 'Stream Search',
        status: 'fail',
        duration,
        details: { 
          error: error.message, 
          timeout: isTimeout,
          timeoutMs: searchTimeout
        }
      });
      this.logStep('Stream Search', 'fail', duration, 
        isTimeout ? `Timeout after ${searchTimeout}ms` : `Error: ${error.message}`);
    }
  }

  async step4_StreamResolution() {
    const stepStart = Date.now();
    
    try {
      const testStream = {
        id: 'test-matrix-1080p',
        title: 'The Matrix',
        infoHash: 'd41d8cd98f00b204e9800998ecf8427e',
        fileIdx: 0,
        source: 'test'
      };
      
      const resolution = await STREAM_DOMAIN_SERVICE.resolveStream(testStream);
      const duration = Date.now() - stepStart;
      
      const hasPlayableUrl = resolution && resolution.url && 
        (resolution.url.startsWith('http://') || resolution.url.startsWith('https://'));
      
      this.results.push({
        name: 'Stream Resolution',
        status: hasPlayableUrl ? 'pass' : 'fail',
        duration,
        details: {
          inputStream: testStream,
          resolvedUrl: resolution?.url ? 'present' : 'missing',
          urlProtocol: resolution?.url ? new URL(resolution.url).protocol : null,
          headers: resolution?.headers ? Object.keys(resolution.headers) : [],
          expiresAt: resolution?.expiresAt
        }
      });

      this.logStep('Stream Resolution', hasPlayableUrl ? 'pass' : 'fail',