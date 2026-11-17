package app.screenmirror.sender;

import java.nio.ByteBuffer;

/** 송수신 프로토콜 v1 (docs/protocol.md). */
final class Protocol {
    static final int VERSION = 1;
    static final int HEADER_SIZE = 14;
    static final int MAX_PAYLOAD = 8 * 1024 * 1024;

    static final int HELLO = 1;
    static final int ACCEPT = 2;
    static final int REJECT = 3;
    static final int VIDEO_CONFIG = 10;
    static final int VIDEO = 11;
    static final int AUDIO_CONFIG = 20;
    static final int AUDIO = 21;
    static final int CONTROL = 30;
    static final int PING = 31;
    static final int PONG = 32;

    static final int FLAG_KEY = 1;

    static final int TLS_PORT = 47600;
    static final int DISCOVERY_PORT = 47601;

    private Protocol() {}

    static byte[] header(int type, int flags, long pts, int length) {
        ByteBuffer b = ByteBuffer.allocate(HEADER_SIZE); // 기본이 빅엔디언
        b.put((byte) type);
        b.put((byte) flags);
        b.putLong(pts);
        b.putInt(length);
        return b.array();
    }
}
