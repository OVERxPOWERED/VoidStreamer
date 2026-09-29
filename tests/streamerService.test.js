const StreamerService = require('../src/services/streamerService');
const { sanitizeString, validateStreamerId } = require('../src/utils/validation');

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

describe('StreamerService', () => {
  let service;

  beforeEach(() => {
    service = new StreamerService();
  });

  describe('getStreamer', () => {
    it('returns streamer when found', () => {
      const streamer = service.createStreamer({ name: 'TestStreamer', platform: 'twitch' });
      const found = service.getStreamer(streamer.id);
      expect(found).toEqual(streamer);
    });

    it('returns undefined when not found', () => {
      const found = service.getStreamer('non-existent-id');
      expect(found).toBeUndefined();
    });

    it('returns undefined for null/undefined id', () => {
      expect(service.getStreamer(null)).toBeUndefined();
      expect(service.getStreamer(undefined)).toBeUndefined();
    });
  });

  describe('searchStreamers', () => {
    beforeEach(() => {
      service.createStreamer({ name: 'Ninja', platform: 'twitch', category: 'Gaming' });
      service.createStreamer({ name: 'Shroud', platform: 'twitch', category: 'FPS' });
      service.createStreamer({ name: 'Pokimane', platform: 'youtube', category: 'Just Chatting' });
    });

    it('returns all streamers for empty query', () => {
      const results = service.searchStreamers('');
      expect(results).toHaveLength(3);
    });

    it('returns all streamers for whitespace query', () => {
      const results = service.searchStreamers('   ');
      expect(results).toHaveLength(3);
    });

    it('finds partial match case-insensitive', () => {
      const results = service.searchStreamers('nin');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Ninja');
    });

    it('finds multiple partial matches', () => {
      const results = service.searchStreamers('a');
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it('filters by platform', () => {
      const results = service.searchStreamers('', { platform: 'youtube' });
      expect(results).toHaveLength(1);
      expect(results[0].platform).toBe('youtube');
    });

    it('filters by category', () => {
      const results = service.searchStreamers('', { category: 'Gaming' });
      expect(results).toHaveLength(1);
      expect(results[0].category).toBe('Gaming');
    });

    it('combines query with filters', () => {
      const results = service.searchStreamers('nin', { platform: 'twitch' });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Ninja');
    });

    it('returns empty array for no matches', () => {
      const results = service.searchStreamers('xyz123');
      expect(results).toHaveLength(0);
    });
  });

  describe('createStreamer', () => {
    it('creates streamer with valid data', () => {
      const streamer = service.createStreamer({
        name: 'NewStreamer',
        platform: 'twitch',
        category: 'Gaming',
      });
      expect(streamer).toHaveProperty('id');
      expect(streamer.name).toBe('NewStreamer');
      expect(streamer.platform).toBe('twitch');
      expect(streamer.category).toBe('Gaming');
      expect(streamer.isLive).toBe(false);
      expect(streamer.viewerCount).toBe(0);
      expect(streamer.createdAt).toBeInstanceOf(Date);
    });

    it('sanitizes name input', () => {
      const streamer = service.createStreamer({
        name: '<script>alert(1)</script>CleanName',
        platform: 'twitch',
      });
      expect(streamer.name).not.toContain('<script>');
      expect(streamer.name).toBe('CleanName');
    });

    it('throws for missing name', () => {
      expect(() => service.createStreamer({ platform: 'twitch' })).toThrow('Name is required');
    });

    it('throws for missing platform', () => {
      expect(() => service.createStreamer({ name: 'Test' })).toThrow('Platform is required');
    });

    it('throws for invalid platform', () => {
      expect(() => service.createStreamer({ name: 'Test', platform: 'invalid' })).toThrow('Invalid platform');
    });
  });

  describe('createSession', () => {
    let streamer;

    beforeEach(() => {
      streamer = service.createStreamer({ name: 'TestStreamer', platform: 'twitch' });
    });

    it('creates session for valid online streamer', () => {
      service.updateStreamer(streamer.id, { isLive: true, viewerCount: 100 });
      const session = service.createSession(streamer.id);
      expect(session).toHaveProperty('id');
      expect(session.streamerId).toBe(streamer.id);
      expect(session.startTime).toBeInstanceOf(Date);
      expect(session.endTime).toBeNull();
      expect(session.viewerCount).toBe(100);
    });

    it('throws for invalid streamer id', () => {
      expect(() => service.createSession('invalid-id')).toThrow('Streamer not found');
    });

    it('throws for offline streamer', () => {
      expect(() => service.createSession(streamer.id)).toThrow('Streamer is not live');
    });

    it('throws for duplicate active session', () => {
      service.updateStreamer(streamer.id, { isLive: true, viewerCount: 100 });
      service.createSession(streamer.id);
      expect(() => service.createSession(streamer.id)).toThrow('Active session already exists');
    });

    it('allows new session after previous ended', () => {
      service.updateStreamer(streamer.id, { isLive: true, viewerCount: 100 });
      const session1 = service.createSession(streamer.id);
      service.endSession(session1.id);
      const session2 = service.createSession(streamer.id);
      expect(session2.id).not.toBe(session1.id);
    });
  });

  describe('endSession', () => {
    let streamer, session;

    beforeEach(() => {
      streamer = service.createStreamer({ name: 'TestStreamer', platform: 'twitch' });
      service.updateStreamer(streamer.id, { isLive: true, viewerCount: 100 });
      session = service.createSession(streamer.id);
    });

    it('ends session and calculates duration', () => {
      const ended = service.endSession(session.id);
      expect(ended.endTime).toBeInstanceOf(Date);
      expect(ended.duration).toBeGreaterThanOrEqual(0);
      expect(ended.viewerCount).toBe(100);
    });

    it('updates streamer stats', () => {
      service.endSession(session.id);
      const updatedStreamer = service.getStreamer(streamer.id);
      expect(updatedStreamer.totalStreamTime).toBeGreaterThanOrEqual(0);
      expect(updatedStreamer.sessionCount).toBe(1);
    });

    it('sets streamer offline', () => {
      service.endSession(session.id);
      const updatedStreamer = service.getStreamer(streamer.id);
      expect(updatedStreamer.isLive).toBe(false);
      expect(updatedStream