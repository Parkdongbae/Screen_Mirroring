package app.screenmirror.sender;

import android.content.Context;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.projection.MediaProjection;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Display;
import android.view.Surface;

import java.nio.ByteBuffer;

/**
 * 화면을 H.264로 인코딩해 MirrorSession으로 보낸다.
 * 회전·화질 모드가 바뀌면 인코더만 다시 만들고 VirtualDisplay는 유지한다
 * (Android 14부터 MediaProjection 하나로 VirtualDisplay를 한 번만 만들 수 있다).
 */
final class ScreenEncoder implements MirrorSession.StreamSink, DisplayManager.DisplayListener {
    private static final String TAG = "ScreenEncoder";
    private static final String MIME = MediaFormat.MIMETYPE_VIDEO_AVC;
    private static final int FPS = 30;

    private final Context ctx;
    private final MediaProjection projection;
    private final MirrorSession session;
    private final HandlerThread thread = new HandlerThread("screen-encoder");
    private Handler handler;

    private VirtualDisplay display;
    private MediaCodec codec;
    private Surface inputSurface;
    private Thread drainThread;
    private volatile boolean running;
    private volatile boolean stopped;
    private byte[] codecConfig;

    private int width, height, dpi;
    private String mode;
    private volatile int bitrate;
    private int minBitrate, maxBitrate;
    private long lastCongestion = 0;
    private long lastKeyRequest = 0;

    ScreenEncoder(Context ctx, MediaProjection projection, MirrorSession session) {
        this.ctx = ctx;
        this.projection = projection;
        this.session = session;
        this.mode = session.mode();
    }

    void start() {
        thread.start();
        handler = new Handler(thread.getLooper());
        handler.post(() -> {
            applyModeLimits();
            computeSize();
            if (!startCodec()) {
                session.stopByUser();
                return;
            }
            display = projection.createVirtualDisplay("screen-mirror", width, height, dpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, inputSurface, null, handler);
            ctx.getSystemService(DisplayManager.class).registerDisplayListener(this, handler);
            handler.postDelayed(this::adaptTick, 3000);
        });
    }

    void stop() {
        stopped = true;
        if (handler == null) return;
        handler.post(() -> {
            ctx.getSystemService(DisplayManager.class).unregisterDisplayListener(this);
            stopCodec();
            if (display != null) display.release();
            display = null;
            thread.quitSafely();
        });
    }

    // ---------- 크기·화질 ----------

    private void applyModeLimits() {
        if ("grid".equals(mode)) {
            // 교실 PC가 여러 화면으로 나눠 보여 줄 때: 작은 칸에 맞춰 낮춘다.
            minBitrate = 300_000;
            maxBitrate = 1_500_000;
            bitrate = 1_000_000;
        } else if ("quality".equals(mode)) {
            minBitrate = 1_500_000;
            maxBitrate = 8_000_000;
            bitrate = 5_000_000;
        } else {
            minBitrate = 600_000;
            maxBitrate = 4_000_000;
            bitrate = 2_500_000; // 보수적으로 시작해 여유가 있으면 올린다
        }
    }

    private int maxLongSide() {
        if ("grid".equals(mode)) return 960;
        return "quality".equals(mode) ? 1920 : 1280;
    }

    /** 화면 비율을 유지하며 긴 변을 제한하고, 인코더 호환을 위해 16의 배수로 맞춘다. */
    private boolean computeSize() {
        // 서비스에서는 WindowManager 대신 DisplayManager로 실제 화면 크기(현재 회전 반영)를 얻는다.
        Display def = ctx.getSystemService(DisplayManager.class).getDisplay(Display.DEFAULT_DISPLAY);
        DisplayMetrics real = new DisplayMetrics();
        def.getRealMetrics(real);
        int rw = real.widthPixels;
        int rh = real.heightPixels;
        DisplayMetrics dm = real;
        int longSide = Math.max(rw, rh);
        double scale = Math.min(1.0, (double) maxLongSide() / longSide);
        int w = align16((int) Math.round(rw * scale));
        int h = align16((int) Math.round(rh * scale));
        int d = (int) Math.max(120, dm.densityDpi * scale);
        boolean changed = w != width || h != height;
        width = w;
        height = h;
        dpi = d;
        return changed;
    }

    private static int align16(int v) {
        return Math.max(16, (v + 8) / 16 * 16);
    }

    // ---------- 인코더 ----------

    private boolean startCodec() {
        // 구형 기기에서 큰 해상도가 실패하면 줄여서 다시 시도한다.
        for (int attempt = 0; attempt < 3; attempt++) {
            try {
                MediaFormat f = MediaFormat.createVideoFormat(MIME, width, height);
                f.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
                f.setInteger(MediaFormat.KEY_BIT_RATE, bitrate);
                f.setInteger(MediaFormat.KEY_FRAME_RATE, FPS);
                f.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2);
                // 화면이 멈춰 있어도 0.1초마다 프레임을 내보내 지연 누적을 막는다.
                f.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000);
                f.setInteger(MediaFormat.KEY_PRIORITY, 0);
                if (Build.VERSION.SDK_INT >= 29) f.setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0);
                if (Build.VERSION.SDK_INT >= 30) f.setInteger(MediaFormat.KEY_LATENCY, 1);
                MediaCodec c = MediaCodec.createEncoderByType(MIME);
                c.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
                Surface s = c.createInputSurface();
                c.start();
                codec = c;
                inputSurface = s;
                codecConfig = null;
                running = true;
                session.sendVideoConfig(width, height);
                final MediaCodec cc = c;
                drainThread = new Thread(() -> drain(cc), "screen-drain");
                drainThread.start();
                return true;
            } catch (Exception e) {
                Log.w(TAG, "encoder " + width + "x" + height + " failed: " + e);
                width = align16(width * 3 / 4);
                height = align16(height * 3 / 4);
                dpi = Math.max(120, dpi * 3 / 4);
            }
        }
        return false;
    }

    private void stopCodec() {
        running = false;
        if (drainThread != null) {
            try {
                drainThread.join(500);
            } catch (InterruptedException ignored) {
            }
        }
        drainThread = null;
        if (codec != null) {
            try {
                codec.stop();
            } catch (Exception ignored) {
            }
            codec.release();
            codec = null;
        }
        if (inputSurface != null) inputSurface.release();
        inputSurface = null;
    }

    private void restartCodec() {
        if (stopped) return;
        stopCodec();
        if (!startCodec()) {
            session.stopByUser();
            return;
        }
        if (display != null) {
            display.setSurface(inputSurface);
            display.resize(width, height, dpi);
        }
    }

    private void drain(MediaCodec c) {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        while (running) {
            int idx;
            try {
                idx = c.dequeueOutputBuffer(info, 100_000);
            } catch (Exception e) {
                break;
            }
            if (idx < 0) continue;
            try {
                ByteBuffer buf = c.getOutputBuffer(idx);
                if (buf != null && info.size > 0) {
                    buf.position(info.offset);
                    buf.limit(info.offset + info.size);
                    byte[] data = new byte[info.size];
                    buf.get(data);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                        codecConfig = data; // SPS/PPS
                    } else {
                        boolean key = (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
                        if (key && codecConfig != null) {
                            byte[] withConfig = new byte[codecConfig.length + data.length];
                            System.arraycopy(codecConfig, 0, withConfig, 0, codecConfig.length);
                            System.arraycopy(data, 0, withConfig, codecConfig.length, data.length);
                            data = withConfig;
                        }
                        session.sendVideo(data, key, info.presentationTimeUs);
                    }
                }
                c.releaseOutputBuffer(idx, false);
            } catch (Exception e) {
                break;
            }
        }
    }

    // ---------- 회전 ----------

    @Override
    public void onDisplayChanged(int displayId) {
        if (displayId != Display.DEFAULT_DISPLAY || stopped) return;
        if (computeSize()) {
            Log.i(TAG, "rotation -> " + width + "x" + height);
            restartCodec();
        }
    }

    @Override
    public void onDisplayAdded(int displayId) {}

    @Override
    public void onDisplayRemoved(int displayId) {}

    // ---------- StreamSink ----------

    @Override
    public void requestKeyframe() {
        long now = SystemClock.elapsedRealtime();
        if (now - lastKeyRequest < 300) return;
        lastKeyRequest = now;
        MediaCodec c = codec;
        if (c == null) return;
        try {
            Bundle b = new Bundle();
            b.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
            c.setParameters(b);
        } catch (Exception ignored) {
        }
    }

    @Override
    public void setMode(String m) {
        if (handler == null) return;
        handler.post(() -> {
            if (m.equals(mode)) return;
            mode = m;
            applyModeLimits();
            computeSize();
            restartCodec();
        });
    }

    @Override
    public void onCongestion() {
        if (handler == null) return;
        handler.post(() -> {
            long now = SystemClock.elapsedRealtime();
            if (now - lastCongestion < 1000) return;
            lastCongestion = now;
            setBitrate(Math.max(minBitrate, bitrate * 7 / 10));
        });
    }

    @Override
    public int bitrate() {
        return bitrate;
    }

    /** 6초 동안 막힘이 없으면 비트레이트를 조금씩 올린다. */
    private void adaptTick() {
        if (stopped) return;
        if (SystemClock.elapsedRealtime() - lastCongestion > 6000 && bitrate < maxBitrate) {
            setBitrate(Math.min(maxBitrate, bitrate * 115 / 100));
        }
        handler.postDelayed(this::adaptTick, 3000);
    }

    private void setBitrate(int bps) {
        bitrate = bps;
        MediaCodec c = codec;
        if (c == null) return;
        try {
            Bundle b = new Bundle();
            b.putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, bps);
            c.setParameters(b);
        } catch (Exception ignored) {
        }
    }
}
