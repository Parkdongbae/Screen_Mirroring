package app.screenmirror.sender;

import android.net.Uri;

import java.util.ArrayList;
import java.util.List;

/** 접속할 PC 정보. QR 코드나 UDP 탐색 응답에서 만든다. */
final class ConnectTarget {
    final List<String> hosts;
    final int port;
    final String code;
    final String fingerprint; // 인증서 SHA-256(hex 소문자)
    final String pcName;

    ConnectTarget(List<String> hosts, int port, String code, String fingerprint, String pcName) {
        this.hosts = hosts;
        this.port = port;
        this.code = code;
        this.fingerprint = fingerprint;
        this.pcName = pcName;
    }

    /** smirror://connect?h=..&p=..&c=..&f=..&n=.. 를 해석한다. 형식이 틀리면 null. */
    static ConnectTarget fromQr(String text) {
        if (text == null) return null;
        Uri u;
        try {
            u = Uri.parse(text.trim());
        } catch (Exception e) {
            return null;
        }
        if (!"smirror".equals(u.getScheme()) || !"connect".equals(u.getHost())) return null;
        String h = u.getQueryParameter("h");
        String p = u.getQueryParameter("p");
        String c = u.getQueryParameter("c");
        String f = u.getQueryParameter("f");
        if (h == null || p == null || c == null || f == null) return null;
        List<String> hosts = new ArrayList<>();
        for (String s : h.split(",")) if (!s.trim().isEmpty()) hosts.add(s.trim());
        int port;
        try {
            port = Integer.parseInt(p);
        } catch (NumberFormatException e) {
            return null;
        }
        if (hosts.isEmpty() || !c.matches("\\d{6}") || !f.matches("[0-9a-f]{64}")) return null;
        String n = u.getQueryParameter("n");
        return new ConnectTarget(hosts, port, c, f, n == null ? "교실 PC" : n);
    }
}
