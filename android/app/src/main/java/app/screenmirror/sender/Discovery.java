package app.screenmirror.sender;

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;

/** 6자리 코드로 같은 네트워크 대역의 PC를 UDP 브로드캐스트로 찾는다. */
final class Discovery {
    private Discovery() {}

    /** 찾지 못하면 null. 네트워크 스레드에서 호출한다. */
    static ConnectTarget find(String code, int timeoutMs) {
        try (DatagramSocket sock = new DatagramSocket()) {
            sock.setBroadcast(true);
            sock.setSoTimeout(300);
            byte[] req = new JSONObject().put("t", "disc").put("code", code).toString().getBytes(StandardCharsets.UTF_8);
            Set<InetAddress> targets = broadcastAddresses();
            long end = System.currentTimeMillis() + timeoutMs;
            long nextSend = 0;
            byte[] buf = new byte[2048];
            while (System.currentTimeMillis() < end) {
                if (System.currentTimeMillis() >= nextSend) {
                    for (InetAddress a : targets) {
                        try {
                            sock.send(new DatagramPacket(req, req.length, a, Protocol.DISCOVERY_PORT));
                        } catch (Exception ignored) {
                        }
                    }
                    nextSend = System.currentTimeMillis() + 500;
                }
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                try {
                    sock.receive(p);
                } catch (SocketTimeoutException e) {
                    continue;
                }
                try {
                    JSONObject r = new JSONObject(new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8));
                    if (!"here".equals(r.optString("t")) || !code.equals(r.optString("code"))) continue;
                    String fp = r.optString("fp");
                    if (!fp.matches("[0-9a-f]{64}")) continue;
                    ArrayList<String> hosts = new ArrayList<>();
                    hosts.add(p.getAddress().getHostAddress());
                    return new ConnectTarget(hosts, r.optInt("port", Protocol.TLS_PORT), code, fp, r.optString("name", "교실 PC"));
                } catch (Exception ignored) {
                }
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private static Set<InetAddress> broadcastAddresses() {
        Set<InetAddress> out = new LinkedHashSet<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    if (ia.getBroadcast() != null) out.add(ia.getBroadcast());
                }
            }
        } catch (Exception ignored) {
        }
        try {
            out.add(InetAddress.getByName("255.255.255.255"));
        } catch (Exception ignored) {
        }
        return out;
    }
}
