const fs = require('fs').promises;
const path = require('path');
const StreamSchedulerService = require('../../src/services/StreamSchedulerService');
const StreamRecordingService = require('../../src/services/StreamRecordingService');

jest.mock('../../src/services/StreamRecordingService');

const TEST_SCHEDULES_FILE = path.join(__dirname, '..', 'fixtures', 'test-schedules.json');
const TEST_RECORDINGS_DIR = path.join(__dirname, '..', 'fixtures', 'recordings');

describe('StreamSchedulerService Integration Tests', () => {
  let scheduler;
  let mockRecordingService;

  beforeAll(() => {
    jest.useFakeTimers();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(async () => {
    await fs.mkdir(path.dirname(TEST_SCHEDULES_FILE), { recursive: true });
    await fs.mkdir(TEST_RECORDINGS_DIR, { recursive: true });
    await fs.writeFile(TEST_SCHEDULES_FILE, '[]', 'utf8');

    mockRecordingService = {
      record: jest.fn().mockImplementation(async (options) => {
        await new Promise(resolve => setTimeout(resolve, options.duration || 100));
        return { success: true, filePath: options.outputPath };
      }),
      stop: jest.fn().mockResolvedValue({ success: true }),
      getActiveRecordings: jest.fn().mockReturnValue([]),
    };

    StreamRecordingService.mockImplementation(() => mockRecordingService);

    scheduler = new StreamSchedulerService({
      schedulesFile: TEST_SCHEDULES_FILE,
      recordingsDir: TEST_RECORDINGS_DIR,
      maxConcurrentRecordings: 2,
      recordingService: mockRecordingService,
    });

    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.stop();
    await fs.writeFile(TEST_SCHEDULES_FILE, '[]', 'utf8');
    jest.clearAllMocks();
  });

  describe('Schedule Persistence', () => {
    test('addSchedule persists schedule to JSON file', async () => {
      const schedule = {
        name: 'Test Stream',
        url: 'https://example.com/stream.m3u8',
        cronExpression: '0 2 * * *',
        duration: 3600,
        enabled: true,
      };

      const added = await scheduler.addSchedule(schedule);
      expect(added.id).toBeDefined();
      expect(added.name).toBe('Test Stream');

      const fileContent = await fs.readFile(TEST_SCHEDULES_FILE, 'utf8');
      const schedules = JSON.parse(fileContent);
      expect(schedules).toHaveLength(1);
      expect(schedules[0].name).toBe('Test Stream');
      expect(schedules[0].url).toBe('https://example.com/stream.m3u8');
      expect(schedules[0].cronExpression).toBe('0 2 * * *');
      expect(schedules[0].duration).toBe(3600);
      expect(schedules[0].enabled).toBe(true);
    });

    test('getSchedules returns all persisted schedules', async () => {
      await scheduler.addSchedule({ name: 'Stream 1', url: 'url1', cronExpression: '0 1 * * *', duration: 100 });
      await scheduler.addSchedule({ name: 'Stream 2', url: 'url2', cronExpression: '0 2 * * *', duration: 200 });

      const schedules = await scheduler.getSchedules();
      expect(schedules).toHaveLength(2);
      expect(schedules.map(s => s.name)).toEqual(['Stream 1', 'Stream 2']);
    });

    test('removeSchedule removes schedule from persistence', async () => {
      const added = await scheduler.addSchedule({ name: 'To Remove', url: 'url', cronExpression: '0 3 * * *', duration: 100 });
      await scheduler.removeSchedule(added.id);

      const fileContent = await fs.readFile(TEST_SCHEDULES_FILE, 'utf8');
      const schedules = JSON.parse(fileContent);
      expect(schedules).toHaveLength(0);
    });

    test('updateSchedule modifies existing schedule in persistence', async () => {
      const added = await scheduler.addSchedule({ name: 'Original', url: 'url', cronExpression: '0 4 * * *', duration: 100 });
      await scheduler.updateSchedule(added.id, { name: 'Updated', duration: 200 });

      const fileContent = await fs.readFile(TEST_SCHEDULES_FILE, 'utf8');
      const schedules = JSON.parse(fileContent);
      expect(schedules[0].name).toBe('Updated');
      expect(schedules[0].duration).toBe(200);
      expect(schedules[0].url).toBe('url');
    });
  });

  describe('Cron Triggering', () => {
    test('cron trigger fires recording at correct time', async () => {
      const schedule = await scheduler.addSchedule({
        name: 'Cron Test',
        url: 'https://example.com/live.m3u8',
        cronExpression: '0 12 * * *',
        duration: 600,
      });

      const recordingPromise = new Promise(resolve => {
        scheduler.once('recordingStarted', resolve);
      });

      jest.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));
      await jest.runAllTimersAsync();

      const recording = await recordingPromise;
      expect(recording.scheduleId).toBe(schedule.id);
      expect(mockRecordingService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://example.com/live.m3u8',
          duration: 600,
          outputPath: expect.stringContaining('Cron Test'),
        })
      );
    });

    test('disabled schedule does not trigger recording', async () => {
      await scheduler.addSchedule({
        name: 'Disabled Stream',
        url: 'https://example.com/disabled.m3u8',
        cronExpression: '0 13 * * *',
        duration: 600,
        enabled: false,
      });

      jest.setSystemTime(new Date('2024-01-15T13:00:00.000Z'));
      await jest.runAllTimersAsync();

      expect(mockRecordingService.record).not.toHaveBeenCalled();
    });

    test('enableSchedule activates previously disabled schedule', async () => {
      const added = await scheduler.addSchedule({
        name: 'Toggle Stream',
        url: 'https://example.com/toggle.m3u8',
        cronExpression: '0 14 * * *',
        duration: 600,
        enabled: false,
      });

      jest.setSystemTime(new Date('2024-01-15T14:00:00.000Z'));
      await jest.runAllTimersAsync();
      expect(mockRecordingService.record).not.toHaveBeenCalled();

      await scheduler.enableSchedule(added.id);
      mockRecordingService.record.mockClear();

      jest.setSystemTime(new Date('2024-01-15T15:00:00.000Z'));
      await jest.runAllTimersAsync();
      expect(mockRecordingService.record).toHaveBeenCalledTimes(1);
    });

    test('disableSchedule deactivates active schedule', async () => {
      const added = await scheduler.addSchedule({
        name: 'Active Stream',
        url: 'https://example.com/active.m3u8',
        cronExpression: '0 16 * * *',
        duration: 600,
        enabled: true,
      });

      await scheduler.disableSchedule(added.id);
      mockRecordingService.record.mockClear();

      jest.setSystemTime(new Date('2024-01-15T16:00:00.000Z'));
      await jest.runAllTimersAsync();
      expect(mockRecordingService.record).not.toHaveBeenCalled();
    });
  });

  describe('Concurrency Limiting', () => {
    test('maxConcurrentRecordings limits parallel recordings', async () => {
      const schedulerWithLimit = new StreamSchedulerService({
        schedulesFile: TEST_SCHEDULES_FILE,
        recordingsDir: TEST_RECORDINGS_DIR,
        maxConcurrentRecordings: 2,
        recordingService: mockRecordingService,
      });
      await schedulerWithLimit.start();

      const schedule1 = await schedulerWithLimit.addSchedule({
        name: 'Concurrent 1',
        url: 'url1',
        cronExpression: '0 17 * * *',
        duration: 10000,
      });
      const schedule2 = await schedulerWithLimit.addSchedule({
        name: 'Concurrent 2',
        url: 'url2',
        cronExpression: '0 17 * * *',
        duration: 10000,
      });
      const schedule3 = await schedulerWithLimit.addSchedule({
        name: 'Concurrent 3',
        url: 'url3',
        cronExpression: '0 17 * * *',
        duration: 10000,
      });

      const startedRecordings = [];
      schedulerWithLimit.on('recordingStarted', (r) => startedRecordings.push(r));

      jest.setSystemTime(new Date('2024-01-15T17:00:00.000Z'));
      await jest.runAllTimersAsync();

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(startedRecordings).toHaveLength(2);
      expect(mockRecordingService.record).toHaveBeenCalledTimes(2);

      await schedulerWithLimit.stop();
    });

    test('queued recordings start when slot becomes available', async () => {
      const schedulerWithLimit = new StreamSchedulerService({
        schedulesFile: TEST_SCHEDULES_FILE,
        recordingsDir: TEST_RECORDINGS_DIR,
        maxConcurrentRecordings: 1,
        recordingService: mockRecordingService,
      });
      await schedulerWithLimit.start();

      await schedulerWithLimit.addSchedule({
        name: 'Long Recording',
        url: 'long',
        cronExpression: '0 18 * * *',
        duration: 5000,
      });
      await schedulerWithLimit.addSchedule({
        name: 'Queued Recording',
        url: 'queued',
        cronExpression: '0 18 * * *',
        duration: 1000,
      });

      const startedRecordings = [];
      schedulerWithLimit.on('recordingStarted', (r) => startedRecordings.push(r));

      jest.setSystemTime(new Date('2024-01-15T18:00:00.000Z'));
      await jest.runAllTimersAsync();

      expect(startedRecordings).toHaveLength(1);
      expect(startedRecordings[0].name).toBe('Long Recording');

      jest.advanceTimersByTime(5000);
      await jest.runAllTimersAsync();

      expect(startedRecordings).toHaveLength(2);
      expect(startedRecordings[1].name).toBe('Queued Recording');

      await schedulerWithLimit.stop();
    });
  });

  describe('Event Emission', () => {
    test('events emitted in correct order for successful recording', async () => {
      const schedule = await scheduler.addSchedule({
        name: 'Event Test',
        url: 'https://example.com/events.m3u8',
        cronExpression: '0 19 * * *',
        duration: 100,
      });

      const events = [];
      scheduler.on('scheduleTriggered', (e) => events.push({ type: 'scheduleTriggered', ...e }));
      scheduler.on('recordingStarted', (e) => events.push({ type: 'recordingStarted', ...e }));
      scheduler.on('recordingCompleted', (e) => events.push({ type: 'recordingCompleted', ...e }));

      jest.setSystemTime(new Date('2024-01-15T19:00:00.000Z'));
      await jest.runAllTimersAsync();

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(events.map(e => e.type)).toEqual([
        'scheduleTriggered',
        'recordingStarted',
        'recordingCompleted',
      ]);
      expect(events[0].scheduleId).toBe(schedule.id);
      expect(events[1].scheduleId).toBe(schedule.id);
      expect(events[2].scheduleId).toBe(schedule.id);
    });

    test('recordingFailed event emitted on recording error', async () => {
      mockRecordingService.record.mockRejectedValueOnce(new Error('Network error'));

      const schedule = await scheduler.addSchedule({
        name: 'Fail Test',
        url: 'https://example.com/fail.m3u8',
        cronExpression: '0 20 * * *',
        duration: 100,
      });

      const events = [];
      scheduler.on('scheduleTriggered', (e) => events.push({ type: 'scheduleTriggered', ...e }));
      scheduler.on('recordingStarted', (e) => events.push({ type: 'recordingStarted', ...e }));
      scheduler.on('recordingFailed', (e) => events.push({ type: 'recordingFailed', ...e }));

      jest.setSystemTime(new Date('2024-01-15T20:00:00.000Z'));
      await jest.runAllTimersAsync();

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(events.map(e => e.type)).toEqual([
        'scheduleTriggered',
        'recordingStarted',
        'recordingFailed',
      ]);
      expect(events[2].error).toBeDefined();
      expect(events[2].error.message).toBe('Network error');
    });

    test('scheduleAdded and scheduleRemoved events emitted', async () => {
      const events = [];
      scheduler.on('scheduleAdded', (e) => events.push({ type: 'scheduleAdded', ...e }));
      scheduler.on('scheduleRemoved', (e) => events.push({ type: 'scheduleRemoved', ...e }));

      const added = await scheduler.addSchedule({
        name: 'Event Schedule',
        url: 'url',
        cronExpression: '0 21 * * *',
        duration: 100,
      });
      await scheduler.removeSchedule(added.id);

      expect(events.map(e => e.type)).toEqual(['scheduleAdded', 'scheduleRemoved']);
      expect(events[0].schedule.id).toBe(added.id);
      expect(events[1].scheduleId).toBe(added.id);
    });

    test('scheduleEnabled and scheduleDisabled events emitted', async () => {
      const events = [];
      scheduler.on('scheduleEnabled', (e) => events.push({ type: 'scheduleEnabled', ...e }));
      scheduler.on('scheduleDisabled', (e) => events.push({ type: 'scheduleDisabled', ...e }));

      const added = await scheduler.addSchedule({
        name: 'Toggle Event',
        url: 'url',
        cronExpression: '0 22 * * *',
        duration: 100,
        enabled: true,
      });
      await scheduler.disableSchedule(added.id);
      await scheduler.enableSchedule(added.id);

      expect(events.map(e => e.type)).toEqual(['scheduleDisabled', 'scheduleEnabled']);
    });
  });

  describe('Persistence Across Restart', () => {
    test('schedules persist and are loaded on service restart', async () => {
      const schedule = await scheduler.addSchedule({
        name: 'Persist Test',
        url: 'https://example.com/persist.m3u8',
        cronExpression: '0 23 * * *',
        duration: 600,
        enabled: true,
      });
      const scheduleId = schedule.id;

      await scheduler.stop();

      const scheduler2 = new StreamSchedulerService({
        schedulesFile: TEST_SCHEDULES_FILE,
        recordingsDir: TEST_RECORDINGS_DIR,
        maxConcurrentRecordings: 2,
        recordingService: mockRecordingService,
      });
      await scheduler2.start();

      const schedules = await scheduler2.getSchedules();
      expect(schedules).toHaveLength(1);
      expect(schedules[0].id).toBe(scheduleId);
      expect(schedules[0].name).toBe('Persist Test');
      expect(schedules[0].enabled).toBe(true);

      await scheduler2.stop();
    });

    test('cron jobs are re-registered on restart', async () => {
      await scheduler.addSchedule({
        name: 'Restart Cron',
        url: 'https://example.com/restart.m3u8',
        cronExpression: '0 0 * * *',
        duration: 100,
        enabled: true,
      });

      await scheduler.stop();

      const scheduler2 = new StreamSchedulerService({
        schedulesFile: TEST_SCHEDULES_FILE,
        recordingsDir: TEST_RECORDINGS_DIR,
        maxConcurrentRecordings: 2,
        recordingService: mockRecordingService,
      });
      await scheduler2.start();

      const recordingPromise = new Promise(resolve => {
        scheduler2.once('recordingStarted', resolve);
      });

      jest.setSystemTime(new Date('2024-01-16T00:00:00.000Z'));
      await jest.runAllTimersAsync