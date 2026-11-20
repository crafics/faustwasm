/**
 * Faust's MIDI sync controls, played by MIDI's real-time messages and its Song
 * Position Pointer, as the C++ MidiUI plays them (architecture/faust/gui/
 * MidiUI.h, midi/midi.h): `[midi:start]` 1 on a Start or a Continue,
 * `[midi:stop]` 0 on a Stop, `[midi:clock]` toggling on each clock, and
 * `[midi:songpos]` the song position in sixteenths - the place of the last
 * clock: a Song Position Pointer sets the place of the next one, a Start makes
 * it 0, a Continue keeps it, each clock moves it on by a sixth. Whatever the
 * MIDI channel the DSP listens to.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    instantiateFaustModuleFromFile,
    LibFaust,
    FaustCompiler,
    FaustMonoDspGenerator,
    FaustPolyDspGenerator
} from '../../dist/esm/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAMPLE_RATE = 48000;
const BLOCK = 128;

/** Each sync control as an output, read back after a block. */
const SYNC = `declare options "[midichannel:3]";
play = checkbox("play[midi:start][midi:stop]");
clk = checkbox("clk[midi:clock]");
pos = hslider("pos[midi:songpos]", 0, 0, 1e9, 0.0001);
process = clk, play, pos;`;

/** The same as an instrument's voice: its outputs while a note is held. */
const SYNC_VOICE = `declare options "[nvoices:2]";
freq = hslider("freq", 440, 20, 8000, 0.01);
gain = hslider("gain", 0.5, 0, 1, 0.01);
gate = button("gate");
play = checkbox("play[midi:start][midi:stop]");
clk = checkbox("clk[midi:clock]");
pos = hslider("pos[midi:songpos]", 0, 0, 1e9, 0.0001);
on = gate > 0;
process = clk * on, play * on, pos * on + 0 * freq * gain;`;

/** @type {any} */ let compiler;
before(async () => {
    const faustModule = await instantiateFaustModuleFromFile(
        path.join(ROOT, 'libfaust-wasm', 'libfaust-wasm.js')
    );
    compiler = new FaustCompiler(new LibFaust(faustModule));
});

/** The last frame of each output after a block. */
function block(processor) {
    const out = processor.render([], BLOCK);
    return { clk: out[0][BLOCK - 1], play: out[1][BLOCK - 1], pos: out[2][BLOCK - 1] };
}

/** What each message makes of the controls: a list of [message, then] pairs. */
function play(processor, messages) {
    return messages.map((m) => {
        processor.midiMessage(m);
        return block(processor);
    });
}

const SPP = (sixteenths) => [0xf2, sixteenths & 0x7f, (sixteenths >> 7) & 0x7f];

for (const kind of ['monophonic', 'polyphonic']) {
    const make = async () => {
        if (kind === 'monophonic') {
            const generator = new FaustMonoDspGenerator();
            await generator.compile(compiler, 'sync', SYNC, '-ftz 2');
            return generator.createOfflineProcessor(SAMPLE_RATE, BLOCK);
        }
        const generator = new FaustPolyDspGenerator();
        await generator.compile(compiler, 'syncvoice', SYNC_VOICE, '-ftz 2');
        const processor = await generator.createOfflineProcessor(SAMPLE_RATE, BLOCK, 2);
        processor.midiMessage([0x90, 60, 100]);
        return processor;
    };

    test(`${kind}: a Start, clocks, a Stop - each control as MidiUI moves it`, async () => {
        const p = await make();
        assert.ok(p, 'the processor has to exist');
        assert.deepEqual(block(p), { clk: 0, play: 0, pos: 0 }, 'nothing before');
        const [start, t1, t2, t3, stop] = play(p, [[0xfa], [0xf8], [0xf8], [0xf8], [0xfc]]);
        assert.equal(start.play, 1, 'a Start: [midi:start] 1');
        assert.equal(start.pos, 0, 'a Start: the song position 0');
        assert.deepEqual([t1.clk, t2.clk, t3.clk], [1, 0, 1], 'each clock toggles [midi:clock]');
        assert.deepEqual([t1.pos, t2.pos, t3.pos].map((x) => Math.fround(x)), [0, 1 / 6, 2 / 6].map(Math.fround), 'each clock: the place of that clock, a sixth on');
        assert.equal(stop.play, 0, 'a Stop: [midi:stop] 0');
    });

    test(`${kind}: the Song Position Pointer sets the place of the next clock; a Continue keeps it`, async () => {
        const p = await make();
        const [set, tick, cont, next] = play(p, [SPP(16), [0xf8], [0xfb], [0xf8]]);
        assert.equal(set.pos, 16, 'at once');
        assert.equal(tick.pos, 16, "the next clock: the pointer's place");
        assert.equal(cont.play, 1, 'a Continue plays');
        assert.equal(Math.fround(next.pos), Math.fround(16 + 1 / 6), 'and keeps the place');
        // a jump back to a place passed before: seen as a fall
        const [back] = play(p, [SPP(0)]);
        assert.equal(back.pos, 0);
        // the 14 bits
        const [far] = play(p, [SPP(16383)]);
        assert.equal(far.pos, 16383);
    });

    test(`${kind}: sync whatever the MIDI channel the DSP listens to`, async () => {
        const p = await make();
        // (the DSP listens to channel 3 only in its mono form; sync is no channel message anyway)
        if (kind === 'monophonic') {
            p.midiMessage([0xb0, 1, 64]);
        }
        const [start] = play(p, [[0xfa]]);
        assert.equal(start.play, 1);
    });
}

test('a long count stays exact: whole clocks, not sixths summed', async () => {
    const generator = new FaustMonoDspGenerator();
    await generator.compile(compiler, 'sync', SYNC, '-ftz 2');
    const p = await generator.createOfflineProcessor(SAMPLE_RATE, BLOCK);
    p.midiMessage([0xfa]);
    for (let k = 0; k < 6 * 1000; k++) p.midiMessage([0xf8]);
    assert.equal(Math.fround(block(p).pos), Math.fround((6 * 1000 - 1) / 6));
});
