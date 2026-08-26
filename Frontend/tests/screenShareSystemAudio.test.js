import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';


const voicePanelSource = await readFile(
  new URL('../src/components/VoicePanel.jsx', import.meta.url),
  'utf8',
);
const voiceSessionSource = await readFile(
  new URL('../src/hooks/useVoiceSession.js', import.meta.url),
  'utf8',
);


test('screen sharing opens a minimal options modal before capture', () => {
  assert.match(voicePanelSource, /screenShareModalOpen/);
  assert.match(voicePanelSource, />\s*Share Screen\s*</);
  assert.match(voicePanelSource, /Share system audio/);
  assert.match(voicePanelSource, />\s*Cancel\s*</);
  assert.match(voicePanelSource, />\s*Start Sharing\s*</);
  assert.match(voicePanelSource, /openScreenShareModal/);
  assert.match(
    voicePanelSource,
    /handleStartScreenShare\(\{ shareSystemAudio \}\)/,
  );
});

test('display capture uses the selected audio preference with video always enabled', () => {
  assert.match(
    voiceSessionSource,
    /getDisplayMedia\(\{\s*video: true,\s*audio: Boolean\(shareSystemAudio\),\s*\}\)/,
  );
  assert.match(
    voiceSessionSource,
    /getDisplayMedia\(\{\s*video: true,\s*audio: false,\s*\}\)/,
  );
  assert.match(voiceSessionSource, /audioConstraintUnsupported/);
});

test('system audio uses a separate sender and is removed when sharing stops', () => {
  assert.match(voiceSessionSource, /screenAudioTrackRef/);
  assert.match(voiceSessionSource, /screenAudioSendersRef/);
  assert.match(
    voiceSessionSource,
    /pc\.addTrack\(\s*screenAudioTrack,\s*screenStream,\s*\)/,
  );
  assert.match(voiceSessionSource, /pc\.removeTrack\(screenAudioSender\)/);
  assert.match(voiceSessionSource, /screenAudioTrack\.stop\(\)/);
  assert.match(voiceSessionSource, /screenStream\?\.getTracks\(\)\.forEach/);
});

test('existing microphone and video sender behavior remains present', () => {
  assert.match(
    voiceSessionSource,
    /localStreamRef\.current\.getAudioTracks\(\)\.forEach/,
  );
  assert.match(voiceSessionSource, /sender\.replaceTrack\(screenTrack\)/);
  assert.match(voiceSessionSource, /sender\.replaceTrack\(cameraTrack\)/);
  assert.match(voiceSessionSource, /broadcastScreenShareState\(true\)/);
  assert.match(voiceSessionSource, /broadcastScreenShareState\(false\)/);
});
