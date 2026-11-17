package app.screenmirror.sender;

import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.LinkedBlockingDeque;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * PC와의 연결 하나를 관리한다(앱 전체에서 하나).
 * 연결·승인 대기·OS 동의·전송·종료 상태를 화면과 서비스에 알린다.
 */
final class MirrorSession {
    private static final String TAG = "MirrorSession";

    enum State { IDLE, CONNECTING, WAITING_APPROVAL, NEED_CONSENT, STREAMING, ENDED }

    interface Listener {
        void onSessionChanged(State state, String message);
    }

    /** 화면 인코더가 구현한다. */
    interface StreamSink {
        void requestKeyframe();

        void setMode(String mode);

        void onCongestion();

        int bitrate();
    }

    private static final MirrorSession INSTANCE = new MirrorSession();

    static MirrorSession get() {
        return INSTANCE;
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();
    private final LinkedBlockingDeque<Packet> queue = new LinkedBlockingDeque<>();
    private final AtomicLong queuedVideoBytes = new AtomicLong();
    private final AtomicLong queuedBytes = new AtomicLong();

    private volatile State state = State.IDLE;
    private volatile String message = "";
    private volatile String mode = "stable";
    private volatile String pcName = "";
    private volatile boolean dropUntilKey = false;
    private volatile boolean audioMuted = false; // 교실 PC에서 이 기기의 소리를 끈 상태
    private volatile StreamSink sink;

    private Context app;
    private SSLSocket socket;
    private OutputStream out;
    private int generation = 0;

    private static final class Packet {
        final int type;
        final int flags;
        final long pts;
        final byte[] data;
        final boolean video;

        Packet(int type, int flags, long pts, byte[] data, boolean video) {
            this.type = type;
            this.flags = flags;
            this.pts = pts;
            this.data = data;
            this.video = video;
        }
    }

    private MirrorSession() {}

    // ---------- 상태 ----------

    State state() {
        return state;
    }

    String message() {
        return message;
    }

    String mode() {
        return mode;
    }

    String pcName() {
        return pcName;
    }

    void addListener(Listener l) {
        listeners.add(l);
        l.onSessionChanged(state, message);
    }

    void removeListener(Listener l) {
        listeners.remove(l);
    }

    private void setState(State s, String msg) {
        state = s;
        message = msg;
        main.post(() -> {
            for (Listener l : listeners) l.onSessionChanged(s, msg);
        });
    }

    boolean isActive() {
        State s = state;
        return s == State.CONNECTING || s == State.WAITING_APPROVAL || s == State.NEED_CONSENT || s == State.STREAMING;
    }

    void setSink(StreamSink s) {
        sink = s;
    }

    // ---------- 연결 ----------

    /**
     * QR 정보(target) 또는 6자리 코드(code)로 연결한다. 둘 중 하나만 준다.
     */
    synchronized void connect(Context ctx, ConnectTarget target, String code, String deviceName, boolean audio) {
        if (isActive()) return;
        app = ctx.getApplicationContext();
        final int gen = ++generation;
        queue.clear();
        queuedBytes.set(0);
        queuedVideoBytes.set(0);
        dropUntilKey = false;
        audioMuted = false;
        setState(State.CONNECTING, target == null ? "같은 네트워크에서 PC를 찾는 중입니다…" : "PC에 연결하는 중입니다…");
        new Thread(() -> runConnect(gen, target, code, deviceName, audio), "mirror-connect").start();
    }

    private void runConnect(int gen, ConnectTarget target, String code, String deviceName, boolean audio) {
        ConnectTarget t = target;
        if (t == null) {
            t = Discovery.find(code, 3000);
            if (t == null) {
                fail(gen, "이 코드를 사용하는 PC를 찾지 못했습니다. 코드를 다시 확인하거나, PC 화면의 QR 코드를 스캔해 주세요. (휴대전화와 PC가 다른 네트워크에 있으면 QR 코드로만 연결됩니다.)");
                return;
            }
        }
        pcName = t.pcName;
        SSLSocket s = null;
        boolean mismatch = false;
        for (String host : t.hosts) {
            Socket raw = null;
            try {
                raw = new Socket();
                raw.connect(new InetSocketAddress(host, t.port), 3000);
                raw.setTcpNoDelay(true);
                raw.setSendBufferSize(256 * 1024);
                SSLSocketFactory f = PinnedTrust.context(t.fingerprint).getSocketFactory();
                SSLSocket ss = (SSLSocket) f.createSocket(raw, host, t.port, true);
                ss.setSoTimeout(10000);
                ss.startHandshake();
                s = ss;
                break;
            } catch (Exception e) {
                Log.w(TAG, "connect " + host + " failed: " + e);
                if (hasCause(e, PinnedTrust.FingerprintMismatch.class)) mismatch = true;
                try {
                    if (raw != null) raw.close();
                } catch (IOException ignored) {
                }
            }
        }
        if (s == null) {
            fail(gen, mismatch
                    ? "PC를 확인할 수 없습니다(보안 인증 불일치). PC 화면의 QR 코드를 다시 스캔해 주세요."
                    : "PC에 연결할 수 없습니다. 휴대전화와 PC가 같은 학교 네트워크에 있는지 확인해 주세요. Wi-Fi에서 기기 간 통신이 막혀 있으면 전산 담당자에게 문의해 주세요.");
            return;
        }
        synchronized (this) {
            if (gen != generation) {
                closeQuietly(s);
                return;
            }
            socket = s;
        }
        try {
            // 승인은 최대 60초까지 기다리므로 그동안은 읽기 제한 시간을 길게 둔다.
            s.setSoTimeout(75000);
            out = new BufferedOutputStream(s.getOutputStream(), 64 * 1024);
            JSONObject hello = new JSONObject()
                    .put("proto", Protocol.VERSION)
                    .put("code", t.code)
                    .put("device", deviceName)
                    .put("model", Build.MANUFACTURER + " " + Build.MODEL)
                    .put("android", Build.VERSION.SDK_INT)
                    .put("audio", audio)
                    .put("app", BuildConfig.VERSION_NAME);
            writePacket(new Packet(Protocol.HELLO, 0, 0, bytes(hello), false));
        } catch (Exception e) {
            fail(gen, "PC에 연결 요청을 보내지 못했습니다.");
            return;
        }
        setState(State.WAITING_APPROVAL, "PC 화면에서 ‘허용’을 눌러 주세요.");
        final SSLSocket sock = s;
        new Thread(() -> readLoop(gen, sock), "mirror-reader").start();
        new Thread(() -> writeLoop(gen), "mirror-writer").start();
    }

    private void readLoop(int gen, SSLSocket s) {
        try {
            DataInputStream in = new DataInputStream(s.getInputStream());
            byte[] head = new byte[Protocol.HEADER_SIZE];
            while (gen == generation) {
                in.readFully(head);
                java.nio.ByteBuffer b = java.nio.ByteBuffer.wrap(head);
                int type = b.get() & 0xff;
                b.get(); // flags
                b.getLong(); // pts
                int len = b.getInt();
                if (len < 0 || len > Protocol.MAX_PAYLOAD) throw new IOException("bad length");
                byte[] payload = new byte[len];
                in.readFully(payload);
                onFrame(gen, s, type, payload);
            }
        } catch (Exception e) {
            if (gen == generation && isActive()) {
                fail(gen, state == State.WAITING_APPROVAL
                        ? "PC가 응답하지 않습니다. PC의 수신 프로그램을 확인해 주세요."
                        : "PC와의 연결이 끊겼습니다. Wi-Fi 연결을 확인한 뒤 다시 연결해 주세요.");
            }
        }
    }

    private void onFrame(int gen, SSLSocket s, int type, byte[] payload) throws Exception {
        switch (type) {
            case Protocol.ACCEPT: {
                JSONObject j = json(payload);
                mode = j.optString("mode", "stable");
                s.setSoTimeout(10000); // 승인 뒤에는 PC가 2초마다 신호를 보낸다
                setState(State.NEED_CONSENT, "휴대전화 화면 공유를 허용해 주세요.");
                break;
            }
            case Protocol.REJECT:
                fail(gen, rejectMessage(json(payload).optString("reason")));
                break;
            case Protocol.CONTROL: {
                JSONObject j = json(payload);
                String t = j.optString("t");
                StreamSink k = sink;
                if ("keyframe".equals(t)) {
                    if (k != null) k.requestKeyframe();
                } else if ("mode".equals(t)) {
                    mode = j.optString("v", mode);
                    if (k != null) k.setMode(mode);
                } else if ("audio_mute".equals(t)) {
                    audioMuted = j.optBoolean("v", false);
                    if (state == State.STREAMING) setState(State.STREAMING, streamingMessage());
                } else if ("bye".equals(t)) {
                    fail(gen, "timeout".equals(j.optString("reason"))
                            ? "시간 안에 화면 공유가 시작되지 않아 PC가 연결을 종료했습니다."
                            : "PC에서 화면 공유를 종료했습니다.");
                }
                break;
            }
            case Protocol.PING:
                enqueueControl(Protocol.PONG, null);
                break;
            default:
                break;
        }
    }

    private void writeLoop(int gen) {
        try {
            while (gen == generation) {
                Packet p = queue.poll(500, TimeUnit.MILLISECONDS);
                if (p == null) continue;
                int n = p.data == null ? 0 : p.data.length;
                queuedBytes.addAndGet(-n);
                if (p.video) queuedVideoBytes.addAndGet(-n);
                writePacket(p);
            }
        } catch (Exception e) {
            if (gen == generation && isActive()) fail(gen, "PC와의 연결이 끊겼습니다. Wi-Fi 연결을 확인한 뒤 다시 연결해 주세요.");
        }
    }

    private void writePacket(Packet p) throws IOException {
        OutputStream o = out;
        if (o == null) throw new IOException("closed");
        int n = p.data == null ? 0 : p.data.length;
        synchronized (o) {
            o.write(Protocol.header(p.type, p.flags, p.pts, n));
            if (n > 0) o.write(p.data);
            o.flush();
        }
    }

    // ---------- 보내기 ----------

    private void enqueueControl(int type, JSONObject j) {
        byte[] d = j == null ? null : bytes(j);
        queue.addFirst(new Packet(type, 0, 0, d, false));
        if (d != null) queuedBytes.addAndGet(d.length);
    }

    void sendControl(JSONObject j) {
        enqueueControl(Protocol.CONTROL, j);
    }

    void sendVideoConfig(int w, int h) {
        try {
            byte[] d = bytes(new JSONObject().put("w", w).put("h", h));
            queue.addLast(new Packet(Protocol.VIDEO_CONFIG, 0, 0, d, false));
            queuedBytes.addAndGet(d.length);
        } catch (Exception ignored) {
        }
    }

    /** 키프레임이 아니고 전송이 밀려 있으면 버리고 키프레임을 요청한다(대역폭 부족 대응). */
    void sendVideo(byte[] data, boolean key, long ptsUs) {
        if (state != State.STREAMING) return;
        if (!key && dropUntilKey) return;
        StreamSink k = sink;
        long limit = Math.max(300_000L, (k == null ? 4_000_000 : k.bitrate()) / 8L * 4 / 10); // 약 0.4초 분량
        if (!key && queuedVideoBytes.get() > limit) {
            dropUntilKey = true;
            if (k != null) {
                k.onCongestion();
                k.requestKeyframe();
            }
            return;
        }
        if (key) dropUntilKey = false;
        queue.addLast(new Packet(Protocol.VIDEO, key ? Protocol.FLAG_KEY : 0, ptsUs, data, true));
        queuedVideoBytes.addAndGet(data.length);
        queuedBytes.addAndGet(data.length);
    }

    void sendAudioConfig(int rate, int channels) {
        try {
            byte[] d = bytes(new JSONObject().put("rate", rate).put("channels", channels).put("format", "s16le"));
            queue.addLast(new Packet(Protocol.AUDIO_CONFIG, 0, 0, d, false));
        } catch (Exception ignored) {
        }
    }

    void sendAudio(byte[] pcm, long ptsUs) {
        if (state != State.STREAMING || audioMuted) return; // 교실 PC에서 끈 소리는 보내지 않는다
        if (queuedBytes.get() > 4_000_000) return; // 심하게 밀리면 소리도 버린다
        queue.addLast(new Packet(Protocol.AUDIO, 0, ptsUs, pcm, false));
        queuedBytes.addAndGet(pcm.length);
    }

    void sendAudioStatus(String v) {
        try {
            sendControl(new JSONObject().put("t", "audio").put("v", v));
        } catch (Exception ignored) {
        }
    }

    // ---------- 단계 전환 ----------

    void onStreamingStarted() {
        if (state == State.NEED_CONSENT) setState(State.STREAMING, streamingMessage());
    }

    private String streamingMessage() {
        return audioMuted
                ? "전자칠판에 화면을 보내는 중입니다.\n여러 기기가 함께 보이고 있어 선생님 PC에서 이 기기의 소리를 꺼 두었습니다."
                : "전자칠판에 화면을 보내는 중입니다.\n다른 앱으로 이동해도 공유가 계속됩니다.";
    }

    void consentDenied() {
        sendByeAndEnd("consent_denied", "화면 공유를 허용하지 않아 연결을 종료했습니다.");
    }

    void stopByUser() {
        if (state == State.CONNECTING) {
            synchronized (this) {
                generation++;
            }
            setState(State.ENDED, "연결을 취소했습니다.");
            return;
        }
        sendByeAndEnd("user", "화면 공유를 종료했습니다.");
    }

    private void sendByeAndEnd(String reason, String msg) {
        if (!isActive()) return;
        final int gen = generation;
        final OutputStream o = out;
        new Thread(() -> {
            try {
                if (o != null) {
                    synchronized (o) {
                        byte[] d = bytes(new JSONObject().put("t", "bye").put("reason", reason));
                        o.write(Protocol.header(Protocol.CONTROL, 0, 0, d.length));
                        o.write(d);
                        o.flush();
                    }
                }
            } catch (Exception ignored) {
            }
            fail(gen, msg);
        }, "mirror-bye").start();
    }

    /** 세션을 끝내고 소켓·서비스를 정리한다. */
    private void fail(int gen, String msg) {
        synchronized (this) {
            if (gen != generation) return;
            generation++;
            closeQuietly(socket);
            socket = null;
            out = null;
            queue.clear();
            queuedBytes.set(0);
            queuedVideoBytes.set(0);
        }
        setState(State.ENDED, msg);
        if (app != null) MirrorService.stop(app);
    }

    void reset() {
        if (!isActive()) setState(State.IDLE, "");
    }

    // ---------- 도우미 ----------

    private static String rejectMessage(String reason) {
        switch (reason) {
            case "rejected": return "PC에서 연결을 거절했습니다.";
            case "busy": return "이 PC는 이미 다른 휴대전화의 화면을 표시하고 있습니다. 공유가 끝난 뒤 다시 시도해 주세요.";
            case "badcode": return "접속 코드가 맞지 않습니다. PC 화면의 코드를 다시 확인해 주세요.";
            case "expired": return "접속 코드가 만료되었습니다. PC 화면에 표시된 새 코드를 사용해 주세요.";
            case "locked": return "코드를 여러 번 잘못 입력했습니다. 1분 뒤 다시 시도해 주세요.";
            case "version": return "PC 프로그램과 앱의 버전이 맞지 않습니다. 둘 다 최신 버전으로 업데이트해 주세요.";
            case "timeout": return "PC에서 승인하지 않아 요청이 취소되었습니다.";
            default: return "PC가 연결을 받아들이지 않았습니다.";
        }
    }

    private static boolean hasCause(Throwable e, Class<?> c) {
        for (Throwable t = e; t != null; t = t.getCause()) if (c.isInstance(t)) return true;
        return false;
    }

    private static JSONObject json(byte[] b) {
        try {
            return new JSONObject(new String(b, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private static byte[] bytes(JSONObject j) {
        return j.toString().getBytes(StandardCharsets.UTF_8);
    }

    private static void closeQuietly(Socket s) {
        try {
            if (s != null) s.close();
        } catch (IOException ignored) {
        }
    }
}
