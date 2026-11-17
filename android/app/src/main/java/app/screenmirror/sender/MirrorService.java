package app.screenmirror.sender;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * 화면 공유 중에 실행되는 포그라운드 서비스.
 * OS 동의 결과로 MediaProjection을 얻어 화면 인코더와 소리 캡처를 돌린다.
 */
public class MirrorService extends Service {
    private static final String CHANNEL = "mirroring";
    private static final int NOTIFICATION_ID = 1;
    private static final String EXTRA_RESULT_CODE = "resultCode";
    private static final String EXTRA_DATA = "data";
    private static final String EXTRA_AUDIO = "audio";
    private static final String ACTION_STOP = "app.screenmirror.sender.STOP";

    private MediaProjection projection;
    private ScreenEncoder encoder;
    private AudioCapturer audio;
    private boolean started;

    static void start(Context c, int resultCode, Intent data, boolean audio) {
        Intent i = new Intent(c, MirrorService.class)
                .putExtra(EXTRA_RESULT_CODE, resultCode)
                .putExtra(EXTRA_DATA, data)
                .putExtra(EXTRA_AUDIO, audio);
        ContextCompat.startForegroundService(c, i);
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, MirrorService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) {
            MirrorSession.get().stopByUser();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (started) return START_NOT_STICKY;
        started = true;

        boolean wantAudio = intent.getBooleanExtra(EXTRA_AUDIO, false);
        boolean audioPermitted = Build.VERSION.SDK_INT >= 29
                && ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;

        Notification n = buildNotification();
        if (Build.VERSION.SDK_INT >= 29) {
            int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
            if (wantAudio && audioPermitted && Build.VERSION.SDK_INT >= 30) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            startForeground(NOTIFICATION_ID, n, type);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }

        MirrorSession session = MirrorSession.get();
        MediaProjectionManager mpm = getSystemService(MediaProjectionManager.class);
        Intent data = intent.getParcelableExtra(EXTRA_DATA);
        try {
            projection = data == null ? null : mpm.getMediaProjection(intent.getIntExtra(EXTRA_RESULT_CODE, 0), data);
        } catch (Exception e) {
            projection = null;
        }
        if (projection == null || !session.isActive()) {
            session.stopByUser();
            stopSelf();
            return START_NOT_STICKY;
        }
        // 화면 잠금이나 시스템 ‘공유 중지’ 버튼으로 끝나는 경우
        projection.registerCallback(new MediaProjection.Callback() {
            @Override
            public void onStop() {
                MirrorSession.get().stopByUser();
                stopSelf();
            }
        }, new Handler(Looper.getMainLooper()));

        encoder = new ScreenEncoder(this, projection, session);
        session.setSink(encoder);
        session.onStreamingStarted();
        encoder.start();

        if (!wantAudio) {
            session.sendAudioStatus("off");
        } else if (Build.VERSION.SDK_INT < 29) {
            session.sendAudioStatus("unsupported");
        } else if (!audioPermitted) {
            session.sendAudioStatus("denied");
        } else {
            audio = new AudioCapturer(projection, session);
            session.sendAudioStatus(audio.start() ? "on" : "unsupported");
        }
        return START_NOT_STICKY;
    }

    private Notification buildNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "화면 공유", NotificationManager.IMPORTANCE_LOW));
        }
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, MirrorService.class).setAction(ACTION_STOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String pc = MirrorSession.get().pcName();
        return new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_cast)
                .setContentTitle("전자칠판에 화면 공유 중")
                .setContentText(pc.isEmpty() ? "교실 PC로 화면을 보내고 있습니다." : pc + "(으)로 화면을 보내고 있습니다.")
                .setOngoing(true)
                .setContentIntent(open)
                .addAction(0, "공유 종료", stop)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .build();
    }

    @Override
    public void onDestroy() {
        if (audio != null && Build.VERSION.SDK_INT >= 29) audio.stop();
        if (encoder != null) encoder.stop();
        MirrorSession.get().setSink(null);
        if (projection != null) {
            try {
                projection.stop();
            } catch (Exception ignored) {
            }
        }
        if (MirrorSession.get().isActive()) MirrorSession.get().stopByUser();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
