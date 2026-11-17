package app.screenmirror.sender;

import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * PC의 자체 서명 인증서를 지문(SHA-256)으로만 신뢰한다.
 * 같은 망의 다른 기기가 PC로 위장해 가로채는 것을 막는다.
 */
final class PinnedTrust {
    static final class FingerprintMismatch extends CertificateException {
        FingerprintMismatch() {
            super("certificate fingerprint mismatch");
        }
    }

    private PinnedTrust() {}

    static SSLContext context(String expectedHex) throws Exception {
        X509TrustManager tm = new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                throw new CertificateException("client auth not supported");
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                if (chain == null || chain.length == 0) throw new FingerprintMismatch();
                byte[] d;
                try {
                    d = MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded());
                } catch (Exception e) {
                    throw new CertificateException(e);
                }
                StringBuilder sb = new StringBuilder();
                for (byte b : d) sb.append(String.format("%02x", b));
                if (!sb.toString().equals(expectedHex)) throw new FingerprintMismatch();
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        };
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, new TrustManager[]{tm}, new SecureRandom());
        return ctx;
    }
}
