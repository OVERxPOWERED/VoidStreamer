```javascript
'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { QueryCacheService } = require('./query-cache-service');
const { StreamDomainService } = require('./stream-domain-service');
const { config } = require('../config/environment');
const { telemetryService } = require('./telemetry-service');

class HealthCheckService {
  constructor() {
    this.queryCacheService = new QueryCacheService();
    this.streamDomainService = new StreamDomainService();
    this.startTime = Date.now();
  }

  async checkHealth() {
    const checks = await Promise.allSettled([
      this.checkDatabase(),
      this.checkCache(),
      this.checkUpstreamSources(),
      this.checkMemory(),
      this.checkUptime()
    ]);

    const results = {
      database: checks[0].status === 'fulfilled' ? checks[0].value : { status: 'unhealthy', error: checks[0].reason?.message },
      cache: checks[1].status === 'fulfilled' ? checks[1].value : { status: 'unhealthy', error: checks[1].reason?.message },
      upstreamSources: checks[2].status === 'fulfilled' ? checks[2].value : { status: 'unhealthy', error: checks[2].reason?.message },
      memory: checks[3].status === 'fulfilled' ? checks[3].value : { status: 'unhealthy', error: checks[3].reason?.message },
      uptime: checks[4].status === 'fulfilled' ? checks[4].value : { status: 'unhealthy', error: checks[4].reason?.message }
    };

    const statuses = Object.values(results).map(r => r.status);
    const overallStatus = statuses.includes('unhealthy') ? 'unhealthy' : 
                          statuses.includes('degraded') ? 'degraded' : 'healthy';

    telemetryService.recordGauge('health_check_overall_status', overallStatus === 'healthy' ? 1 : overallStatus === 'degraded' ? 0.5 : 0);
    telemetryService.recordGauge('health_check_database_status', results.database.status === 'healthy' ? 1 : 0);
    telemetryService.recordGauge('health_check_cache_status', results.cache.status === 'healthy' ? 1 : 0);
    telemetryService.recordGauge('health_check_upstream_status', results.upstreamSources.status === 'healthy' ? 1 : 0);
    telemetryService.recordGauge('health_check_memory_status', results.memory.status === 'healthy' ? 1 : 0);

    return {
      status: overallStatus,
      checks: results,
      timestamp: new Date().toISOString()
    };
  }

  async checkDatabase() {
    try {
      const stats = await this.streamDomainService.getStats();
      return {
        status: 'healthy',
        details: {
          totalSources: stats.totalSources,
          activeSources: stats.activeSources,
          totalStreams: stats.totalStreams
        }
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message
      };
    }
  }

  async checkCache() {
    try {
      const stats = this.queryCacheService.getStats();
      const hitRate = stats.hits + stats.misses > 0 
        ? (stats.hits / (stats.hits + stats.misses) * 100).toFixed(2) 
        : 0;

      let status = 'healthy';
      if (hitRate < 50 && stats.hits + stats.misses > 100) {
        status = 'degraded';
      }
      if (stats.size > config.cache.maxSize * 0.95) {
        status = 'degraded';
      }

      return {
        status,
        details: {
          ...stats,
          hitRate: `${hitRate}%`,
          utilization: `${((stats.size / config.cache.maxSize) * 100).toFixed(2)}%`
        }
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message
      };
    }
  }

  async checkUpstreamSources() {
    try {
      const sources = await this.streamDomainService.getAllSources();
      const activeSources = sources.filter(s => s.isActive);
      
      if (activeSources.length === 0) {
        return {
          status: 'degraded',
          details: {
            total: sources.length,
            active: 0,
            checked: 0,
            healthy: 0,
            message: 'No active upstream sources configured'
          }
        };
      }

      const sampleSize = Math.min(5, activeSources.length);
      const sampledSources = activeSources
        .sort(() => Math.random() - 0.5)
        .slice(0, sampleSize);

      const checkPromises = sampledSources.map(async (source) => {
        const start = Date.now();
        try {
          const response = await axios.head(source.baseUrl, {
            timeout: 5000,
            validateStatus: (status) => status < 500
          });
          return {
            source: source.name,
            url: source.baseUrl,
            status: 'healthy',
            latency: Date.now() - start,
            httpStatus: response.status
          };
        } catch (error) {
          return {
            source: source.name,
            url: source.baseUrl,
            status: 'unhealthy',
            latency: Date.now() - start,
            error: error.message
          };
        }
      });

      const results = await Promise.all(checkPromises);
      const healthyCount = results.filter(r => r.status === 'healthy').length;
      const avgLatency = results.reduce((sum, r) => sum + r.latency, 0) / results.length;

      let status = 'healthy';
      if (healthyCount === 0) {
        status = 'unhealthy';
      } else if (healthyCount < results.length || avgLatency > 3000) {
        status = 'degraded';
      }

      return {
        status,
        details: {
          total: sources.length,
          active: activeSources.length,
          checked: results.length,
          healthy: healthyCount,
          averageLatency: `${Math.round(avgLatency)}ms`,
          sources: results
        }
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message
      };
    }
  }

  async checkMemory() {
    try {
      const memUsage = process.memoryUsage();
      const heapUsedMB = (memUsage.heapUsed / 1024 / 1024).toFixed(2);
      const heapTotalMB = (memUsage.heapTotal / 1024 / 1024).toFixed(2);
      const rssMB = (memUsage.rss / 1024 / 1024).toFixed(2);
      const externalMB = (memUsage.external / 1024 / 1024).toFixed(2);
      const heapUtilization = (memUsage.heapUsed / memUsage.heapTotal * 100).toFixed(2);

      let status = 'healthy';
      if (heapUtilization > 90) {
        status = 'unhealthy';
      } else if (heapUtilization > 75) {
        status = 'degraded';
      }

      telemetryService.recordGauge('memory_heap_used_mb', parseFloat(heapUsedMB));
      telemetryService.recordGauge('memory_heap_total_mb', parseFloat(heapTotalMB));
      telemetryService.recordGauge('memory_rss_mb', parseFloat(rssMB));
      telemetryService.recordGauge('memory_heap_utilization_percent', parseFloat(heapUtilization));

      return {
        status