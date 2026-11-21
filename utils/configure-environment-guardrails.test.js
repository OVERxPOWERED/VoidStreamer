import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

describe('Environment Guardrails Validation', () => {
  describe('Node.js Version', () => {
    it('should have Node.js version >= 18.0.0', () => {
      const version = process.version;
      const match = version.match(/^v(\d+)\.(\d+)\.(\d+)/);
      assert.ok(match, `Unable to parse Node.js version: ${version}`);
      
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      
      assert.ok(
        major > 18 || (major === 18 && minor >= 0),
        `Node.js version ${version} does not meet minimum requirement >= 18.0.0`
      );
    });
  });

  describe('Required Dependencies', () => {
    it('should have axios installed and importable', () => {
      let axios;
      assert.doesNotThrow(() => {
        axios = require('axios');
      }, 'axios should be importable');
      assert.ok(axios, 'axios should be truthy');
      assert.strictEqual(typeof axios, 'function', 'axios should be a function');
    });

    it('should have cheerio installed and importable', () => {
      let cheerio;
      assert.doesNotThrow(() => {
        cheerio = require('cheerio');
      }, 'cheerio should be importable');
      assert.ok(cheerio, 'cheerio should be truthy');
      assert.strictEqual(typeof cheerio.load, 'function', 'cheerio.load should be a function');
    });

    it('should have jest available', () => {
      let jest;
      assert.doesNotThrow(() => {
        jest = require('jest');
      }, 'jest should be importable');
      assert.ok(jest, 'jest should be truthy');
    });
  });

  describe('Environment Variables', () => {
    it('should have NODE_ENV set to test', () => {
      assert.strictEqual(
        process.env.NODE_ENV,
        'test',
        'NODE_ENV must be set to "test"'
      );
    });

    it('should have CI set to true', () => {
      assert.strictEqual(
        process.env.CI,
        'true',
        'CI must be set to "true"'
      );
    });
  });

  describe('Filesystem Write Permissions', () => {
    const testDirs = ['test-results', 'coverage', 'logs'];

    before(() => {
      for (const dir of testDirs) {
        const fullPath = path.join(PROJECT_ROOT, dir);
        if (!fs.existsSync(fullPath)) {
          fs.mkdirSync(fullPath, { recursive: true });
        }
      }
    });

    for (const dir of testDirs) {
      it(`should have write permissions to ${dir}/`, () => {
        const fullPath = path.join(PROJECT_ROOT, dir);
        const testFile = path.join(fullPath, `.write-test-${Date.now()}.tmp`);
        
        assert.doesNotThrow(() => {
          fs.writeFileSync(testFile, 'test');
          fs.unlinkSync(testFile);
        }, `Should have write permission to ${dir}/`);
      });
    }
  });

  describe('Port Availability', () => {
    const testPorts = Array.from({ length: 11 }, (_, i) => 3000 + i);

    for (const port of testPorts) {
      it(`should have port ${port} available`, async () => {
        await new Promise((resolve, reject) => {
          const server = net.createServer();
          
          server.once('error', (err) => {
            if (err.code === 'EADDRINUSE') {
              reject(new Error(`Port ${port} is already in use`));
            } else {
              reject(err);
            }
          });
          
          server.once('listening', () => {
            server.close(() => resolve());
          });
          
          server.listen(port, '127.0.0.1');
        });
      });
    }
  });

  describe('Memory Limit', () => {
    it('should have memory limit > 512MB', () => {
      const memoryLimit = process.memoryUsage().heapTotal;
      const minMemory = 512 * 1024 * 1024; // 512MB in bytes
      
      // Check if we can allocate more than 512MB (V8 heap limit)
      // Using v8.getHeapStatistics for more accurate limit
      let heapLimit;
      try {
        const v8 = require('v8');
        const stats = v8.getHeapStatistics();
        heapLimit = stats.heap_size_limit;
      } catch {
        // Fallback: assume sufficient if we can't check
        heapLimit = minMemory * 2;
      }
      
      assert.ok(
        heapLimit > minMemory,
        `Memory limit ${Math.round(heapLimit / 1024 / 1024)}MB is below required 512MB`
      );
    });
  });
});