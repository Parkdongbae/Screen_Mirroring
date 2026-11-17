package app.screenmirror.sender;

import android.annotation.SuppressLint;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.os.Build;
import android.util.Log;

import androidx.annotation.RequiresApi;

/**
 * 휴대전화에서 재생되는 소리(동영상·게임 등)를 48kHz 스테레오 PCM으로 캡처한다(Android 10 이상).
 * 마이크는 사용하지 않는다. 통화 음성과 캡처를 막아 둔 앱의 소리는 OS가 제외한다.
 */
@RequiresApi(29)
final class AudioCapturer {
    private static final String TAG = "AudioCapturer";
    static final int RATE = 48000;
    static final int CHANNELS = 2;
    private static final int CHUNK_FRAMES = 480; // 10ms

    private final MediaProjection projection;
    private final MirrorSession session;
    private AudioRecord record;
    private Thread thread;
    private volatile boolean running;

    AudioCapturer(MediaProjection projection, MirrorSession session) {
        this.projection = projection;
        this.session = session;
    }

    /** RECORD_AUDIO 권한을 확인한 뒤 호출한다. 실패하면 false. */
    @SuppressLint("MissingPermission")
    boolean start() {
        try {
            AudioPlaybackCaptureConfiguration cfg = new AudioPlaybackCaptureConfiguration.Builder(projection)
                    .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                    .addMatchingUsage(AudioAttributes.USAGE_GAME)
                    .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                    .build();
            AudioFormat fmt = new AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(RATE)
                    .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
                    .build();
            int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT);
            record = new AudioRecord.Builder()
                    .setAudioFormat(fmt)
                    .setBufferSizeInBytes(Math.max(min * 2, RATE * CHANNELS * 2 / 5))
                    .setAudioPlaybackCaptureConfig(cfg)
                    .build();
            if (record.getState() != AudioRecord.STATE_INITIALIZED) throw new IllegalStateException("not initialized");
            record.startRecording();
        } catch (Exception e) {
            Log.w(TAG, "audio capture failed: " + e);
            if (record != null) record.release();
            record = null;
            return false;
        }
        session.sendAudioConfig(RATE, CHANNELS);
        running = true;
        thread = new Thread(this::loop, "audio-capture");
        thread.setPriority(Thread.MAX_PRIORITY);
        thread.start();
        return true;
    }

    private void loop() {
        final int bytes = CHUNK_FRAMES * CHANNELS * 2;
        byte[] buf = new byte[bytes];
        while (running) {
            int n = record.read(buf, 0, bytes);
            if (n <= 0) {
                if (n < 0) break;
                continue;
            }
            byte[] chunk = new byte[n];
            System.arraycopy(buf, 0, chunk, 0, n);
            session.sendAudio(chunk, System.nanoTime() / 1000);
        }
    }

    void stop() {
        running = false;
        if (record != null) {
            try {
                record.stop();
            } catch (Exception ignored) {
            }
        }
        if (thread != null) {
            try {
                thread.join(300);
            } catch (InterruptedException ignored) {
            }
        }
        if (record != null) record.release();
        record = null;
    }

    static boolean supported() {
        return Build.VERSION.SDK_INT >= 29;
    }
}
