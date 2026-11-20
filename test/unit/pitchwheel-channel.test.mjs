/**
 * `[midi:pitchwheel N]`: a pitch wheel on one MIDI channel, and `[midi:pitchbend]`, its other name - as the C++ MidiUI
 * reads them (architecture/faust/gui/MidiUI.h: "pitchwheel %u", "pitchbend %u", "pitchwheel", "pitchbend"). N is a
 * channel in 1..16; none, every channel.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    instantiateFaustModuleFromFile,
    LibFaust,
    FaustCompiler,
    FaustMonoDspGenerator
} from '../../dist/esm/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BLOCK = 128;

const WHEELS = `wany = hslider("any[midi:pitchwheel]", 0, -1, 1, 0.0001);
wtwo = hslider("two[midi:pitchwheel 2]", 0, -1, 1, 0.0001);
walias = hslider("alias[midi:pitchbend]", 0, -1, 1, 0.0001);
waliastwo = hslider("aliastwo[midi:pitchbend 2]", 0, -1, 1, 0.0001);
process = wany, wtwo, walias, waliastwo;`;

/** @type {any} */ let compiler;
before(async () => {
    const faustModule = await instantiateFaustModuleFromFile(
        path.join(ROOT, 'libfaust-wasm', 'libfaust-wasm.js')
    );
    compiler = new FaustCompiler(new LibFaust(faustModule));
});

const last = (p) => p.render([], BLOCK).map((c) => c[BLOCK - 1]);

test('a pitch wheel on one channel, and the pitchbend name', async () => {
    const generator = new FaustMonoDspGenerator();
    await generator.compile(compiler, 'wheels', WHEELS, '-ftz 2');
    const p = await generator.createOfflineProcessor(48000, BLOCK);
    assert.ok(p, 'the processor has to exist');
    // the wheel all the way up on MIDI channel 1 (status 0xE0)
    p.midiMessage([0xe0, 0x7f, 0x7f]);
    const [any1, two1, alias1, aliastwo1] = last(p);
    assert.equal(any1, 1, 'pitchwheel: every channel');
    assert.equal(alias1, 1, 'pitchbend: the same');
    assert.equal(two1, 0, 'pitchwheel 2: not channel 1');
    assert.equal(aliastwo1, 0, 'pitchbend 2: not channel 1');
    // all the way down on channel 2 (0xE1)
    p.midiMessage([0xe1, 0, 0]);
    const [any2, two2, alias2, aliastwo2] = last(p);
    assert.deepEqual([any2, two2, alias2, aliastwo2], [-1, -1, -1, -1], 'channel 2: all four');
});
