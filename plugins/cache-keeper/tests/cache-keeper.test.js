import { expect, mock, test } from 'claude-code/testing';
import { decide, DEFAULT_CONFIG, duration, parseArgs, readConfig, statusText } from '../hooks/register';
const MIN = 60_000;
const HOUR = 60 * MIN;
const idleAt = (t) => ({ lastWarmAt: t, lastActiveAt: t, busy: false, settled: false });
test('settings: defaults, and values out of range are held in range', async () => {
    expect(readConfig({})).toEqual(DEFAULT_CONFIG);
    const odd = readConfig({ keepWarm: false, keepWarmHours: 99, atExpiry: 'explode', cacheTtlMinutes: 5, leadMinutes: 10 });
    expect(odd).toEqual({ keepWarm: false, keepWarmHours: 24, atExpiry: 'nothing', cacheTtlMinutes: 5, leadMinutes: 2.5 });
});
test('nothing happens until the lead window before expiry, nor while a turn runs', async () => {
    const cfg = DEFAULT_CONFIG;
    expect(decide({ busy: false, settled: false }, cfg, 0)).toBe('wait');
    expect(decide(idleAt(0), cfg, 54 * MIN)).toBe('wait');
    expect(decide(idleAt(0), cfg, 55 * MIN)).toBe('keep-warm');
    expect(decide({ ...idleAt(0), busy: true }, cfg, 55 * MIN)).toBe('wait');
    expect(decide({ ...idleAt(0), settled: true }, cfg, 55 * MIN)).toBe('wait');
    expect(decide(idleAt(0), cfg, 61 * MIN)).toBe('expired');
});
test('keep-warms continue for the hours chosen, then the expiry action runs', async () => {
    const cfg = { ...DEFAULT_CONFIG, keepWarmHours: 2, atExpiry: 'compact' };
    // Claude last answered at 0; keep-warms at 55m and 110m carry the cache to 170m, past the 2h window.
    expect(decide({ ...idleAt(55 * MIN), lastActiveAt: 0 }, cfg, 110 * MIN)).toBe('keep-warm');
    expect(decide({ ...idleAt(110 * MIN), lastActiveAt: 0 }, cfg, 165 * MIN)).toBe('compact');
    expect(decide({ ...idleAt(110 * MIN), lastActiveAt: 0 }, { ...cfg, atExpiry: 'handoff' }, 165 * MIN)).toBe('handoff');
    expect(decide({ ...idleAt(110 * MIN), lastActiveAt: 0 }, { ...cfg, atExpiry: 'nothing' }, 165 * MIN)).toBe('let-expire');
});
test('with keep-warm off, the expiry action runs before the first expiry', async () => {
    expect(decide(idleAt(0), { ...DEFAULT_CONFIG, keepWarm: false, atExpiry: 'handoff' }, 56 * MIN)).toBe('handoff');
    expect(decide(idleAt(0), { ...DEFAULT_CONFIG, keepWarmHours: 0, atExpiry: 'compact' }, 56 * MIN)).toBe('compact');
    // A 5-minute cache acts 2.5 minutes before it lapses.
    const short = readConfig({ cacheTtlMinutes: 5 });
    expect(decide(idleAt(0), short, 2 * MIN)).toBe('wait');
    expect(decide(idleAt(0), short, 3 * MIN)).toBe('keep-warm');
});
test('/keepwarm arguments', async () => {
    expect(parseArgs('')).toEqual({ patch: {}, now: false });
    expect(parseArgs('off')).toEqual({ patch: { keepWarm: false }, now: false });
    expect(parseArgs('3h handoff')).toEqual({ patch: { keepWarm: true, keepWarmHours: 3, atExpiry: 'handoff' }, now: false });
    expect(parseArgs('90m now')).toEqual({ patch: { keepWarm: true, keepWarmHours: 1.5 }, now: true });
    expect('error' in parseArgs('forever')).toBe(true);
});
test('the status line', async () => {
    expect(statusText({ busy: false, settled: false }, DEFAULT_CONFIG, 0, 0)).toBeUndefined();
    expect(statusText(idleAt(0), DEFAULT_CONFIG, 18 * MIN, 0)).toBe('🔥 cache 42m');
    expect(statusText(idleAt(0), { ...DEFAULT_CONFIG, atExpiry: 'compact' }, 0, 2)).toBe('🔥 cache 1h · kept warm 2× · then compact');
    expect(statusText(idleAt(0), { ...DEFAULT_CONFIG, keepWarm: false }, 0, 0)).toBe('🔥 cache 1h · keep-warm off');
    expect(statusText(idleAt(0), DEFAULT_CONFIG, 2 * HOUR, 0)).toBe('❄ cache cold');
    expect(statusText(idleAt(0), DEFAULT_CONFIG, 0, 0, 'handed-off')).toBe('cache: cleared with a handoff');
    expect(duration(95 * MIN)).toBe('1h35m');
});
test('/keepwarm now forks over the conversation and reports the cache read', async ($, on) => {
    mock.clock(on, { now: 1_000 });
    on('model.fork', () => ({
        value: {
            isAnswered: true,
            text: 'ok',
            usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 62_931, cache_creation_input_tokens: 177 },
        },
    }));
    const { text } = await $.command.run({ command: 'keepwarm', args: '3h now' });
    expect(text).toContain('Kept warm: read 63k cached tokens, wrote 0k.');
    expect(text).toContain('Keep warm: on, for 3h after');
    expect(text).toContain('Keep-warms this session: 1');
});
