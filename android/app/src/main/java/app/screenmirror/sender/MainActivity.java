package app.screenmirror.sender;

import android.Manifest;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.projection.MediaProjectionConfig;
import android.media.projection.MediaProjectionManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.google.android.material.button.MaterialButton;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.google.android.material.materialswitch.MaterialSwitch;
import com.google.android.material.progressindicator.CircularProgressIndicator;
import com.google.android.material.textfield.TextInputEditText;
import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends AppCompatActivity implements MirrorSession.Listener {
    private final MirrorSession session = MirrorSession.get();
    private SharedPreferences prefs;

    private TextView status;
    private CircularProgressIndicator progress;
    private View connectGroup;
    private MaterialButton btnStop;
    private TextInputEditText codeInput;
    private TextInputEditText deviceName;
    private MaterialSwitch swAudio;

    // 연결을 시작할 때 기억해 두는 값
    private ConnectTarget pendingTarget;
    private String pendingCode;
    private boolean audioForSession;
    private boolean consentRequested;

    private final ActivityResultLauncher<ScanOptions> scanLauncher = registerForActivityResult(new ScanContract(), r -> {
        if (r.getContents() == null) return;
        ConnectTarget t = ConnectTarget.fromQr(r.getContents());
        if (t == null) {
            toast("화면 미러링 PC의 QR 코드가 아닙니다.");
            return;
        }
        beginConnect(t, null);
    });

    private final ActivityResultLauncher<String[]> permLauncher = registerForActivityResult(
            new ActivityResultContracts.RequestMultiplePermissions(), r -> {
                audioForSession = swAudio.isChecked() && hasAudioPermission();
                if (swAudio.isChecked() && Build.VERSION.SDK_INT >= 29 && !audioForSession) {
                    toast("소리 권한이 없어 화면만 보냅니다.");
                }
                confirmDndThenConnect();
            });

    private final ActivityResultLauncher<Intent> consentLauncher = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(), this::onConsentResult);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.root), (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });

        prefs = getSharedPreferences("settings", MODE_PRIVATE);
        status = findViewById(R.id.status);
        progress = findViewById(R.id.progress);
        connectGroup = findViewById(R.id.connect_group);
        btnStop = findViewById(R.id.btn_stop);
        codeInput = findViewById(R.id.code);
        deviceName = findViewById(R.id.device_name);
        swAudio = findViewById(R.id.sw_audio);

        deviceName.setText(prefs.getString("deviceName", defaultDeviceName()));
        if (Build.VERSION.SDK_INT < 29) {
            swAudio.setChecked(false);
            swAudio.setEnabled(false);
            ((TextView) findViewById(R.id.audio_hint)).setText("이 휴대전화(Android 9 이하)는 소리 전송을 지원하지 않아 화면만 보냅니다.");
        } else {
            swAudio.setChecked(prefs.getBoolean("audio", true));
        }

        findViewById(R.id.btn_scan).setOnClickListener(v -> {
            ScanOptions o = new ScanOptions()
                    .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                    .setPrompt("PC 화면의 QR 코드를 비춰 주세요")
                    .setBeepEnabled(false)
                    .setOrientationLocked(false);
            scanLauncher.launch(o);
        });
        findViewById(R.id.btn_connect).setOnClickListener(v -> connectWithCode());
        codeInput.setOnEditorActionListener((v, id, e) -> {
            if (id == EditorInfo.IME_ACTION_GO) {
                connectWithCode();
                return true;
            }
            return false;
        });
        btnStop.setOnClickListener(v -> session.stopByUser());
        findViewById(R.id.btn_dnd).setOnClickListener(v -> openDndSettings());

        handleDeepLink(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleDeepLink(intent);
    }

    /** 기본 카메라 앱으로 QR을 찍어 앱이 열린 경우 */
    private void handleDeepLink(Intent intent) {
        if (intent == null || intent.getData() == null) return;
        ConnectTarget t = ConnectTarget.fromQr(intent.getData().toString());
        intent.setData(null);
        if (t != null && !session.isActive()) beginConnect(t, null);
    }

    @Override
    protected void onStart() {
        super.onStart();
        session.addListener(this);
    }

    @Override
    protected void onStop() {
        session.removeListener(this);
        prefs.edit()
                .putString("deviceName", text(deviceName))
                .putBoolean("audio", swAudio.isChecked())
                .apply();
        super.onStop();
    }

    // ---------- 연결 시작 ----------

    private void connectWithCode() {
        String code = text(codeInput);
        if (!code.matches("\\d{6}")) {
            codeInput.setError("PC 화면에 표시된 6자리 숫자를 입력해 주세요.");
            return;
        }
        InputMethodManager imm = getSystemService(InputMethodManager.class);
        imm.hideSoftInputFromWindow(codeInput.getWindowToken(), 0);
        beginConnect(null, code);
    }

    private void beginConnect(ConnectTarget target, String code) {
        if (session.isActive()) return;
        pendingTarget = target;
        pendingCode = code;
        if (!onLocalNetwork()) {
            new MaterialAlertDialogBuilder(this)
                    .setTitle("학교 Wi-Fi에 연결해 주세요")
                    .setMessage("지금은 휴대전화 데이터(LTE/5G)를 사용 중입니다. 데이터로는 교실 PC에 연결할 수 없습니다.")
                    .setPositiveButton("Wi-Fi 설정 열기", (d, w) -> startActivity(new Intent(Settings.ACTION_WIFI_SETTINGS)))
                    .setNegativeButton("그래도 연결", (d, w) -> requestPermissionsThenConnect())
                    .show();
            return;
        }
        requestPermissionsThenConnect();
    }

    private void requestPermissionsThenConnect() {
        List<String> need = new ArrayList<>();
        if (swAudio.isChecked() && Build.VERSION.SDK_INT >= 29 && !hasAudioPermission()) {
            need.add(Manifest.permission.RECORD_AUDIO);
        }
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (!need.isEmpty()) {
            permLauncher.launch(need.toArray(new String[0]));
            return;
        }
        audioForSession = swAudio.isChecked() && hasAudioPermission();
        confirmDndThenConnect();
    }

    /** 방해 금지 모드가 꺼져 있으면 한 번 더 알려 준다(FR-14). */
    private void confirmDndThenConnect() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getCurrentInterruptionFilter() == NotificationManager.INTERRUPTION_FILTER_ALL) {
            new MaterialAlertDialogBuilder(this)
                    .setTitle("방해 금지 모드가 꺼져 있어요")
                    .setMessage("공유 중에 오는 메시지 알림이 전자칠판에 보일 수 있습니다.")
                    .setPositiveButton("그대로 진행", (d, w) -> doConnect())
                    .setNeutralButton("설정 열기", (d, w) -> openDndSettings())
                    .show();
            return;
        }
        doConnect();
    }

    private void doConnect() {
        consentRequested = false;
        session.reset();
        String name = text(deviceName);
        if (name.isEmpty()) name = defaultDeviceName();
        session.connect(this, pendingTarget, pendingCode, name, audioForSession);
    }

    // ---------- OS 화면 공유 동의 ----------

    private void requestConsent() {
        if (consentRequested) return;
        consentRequested = true;
        MediaProjectionManager mpm = getSystemService(MediaProjectionManager.class);
        Intent i;
        if (Build.VERSION.SDK_INT >= 34) {
            // 전체 화면 또는 앱 하나를 고를 수 있게 한다.
            i = mpm.createScreenCaptureIntent(MediaProjectionConfig.createConfigForUserChoice());
        } else {
            i = mpm.createScreenCaptureIntent();
        }
        try {
            consentLauncher.launch(i);
        } catch (ActivityNotFoundException e) {
            session.consentDenied();
        }
    }

    private void onConsentResult(ActivityResult r) {
        if (r.getResultCode() == RESULT_OK && r.getData() != null && session.state() == MirrorSession.State.NEED_CONSENT) {
            MirrorService.start(this, r.getResultCode(), r.getData(), audioForSession);
        } else {
            session.consentDenied();
        }
    }

    // ---------- 상태 표시 ----------

    @Override
    public void onSessionChanged(MirrorSession.State s, String message) {
        boolean busy = s == MirrorSession.State.CONNECTING || s == MirrorSession.State.WAITING_APPROVAL || s == MirrorSession.State.NEED_CONSENT;
        progress.setVisibility(busy ? View.VISIBLE : View.GONE);
        boolean active = session.isActive();
        connectGroup.setVisibility(active ? View.GONE : View.VISIBLE);
        btnStop.setVisibility(active ? View.VISIBLE : View.GONE);
        btnStop.setText(s == MirrorSession.State.STREAMING ? "공유 종료" : "취소");
        switch (s) {
            case IDLE:
                status.setText("PC 화면의 QR 코드를 스캔하거나 접속 코드를 입력해 주세요.");
                break;
            case NEED_CONSENT:
                status.setText(message);
                requestConsent();
                break;
            default:
                status.setText(message);
        }
    }

    // ---------- 도우미 ----------

    private boolean onLocalNetwork() {
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        Network n = cm.getActiveNetwork();
        NetworkCapabilities c = n == null ? null : cm.getNetworkCapabilities(n);
        if (c == null) return false;
        return c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || c.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET);
    }

    private boolean hasAudioPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    private void openDndSettings() {
        try {
            startActivity(new Intent("android.settings.ZEN_MODE_SETTINGS"));
        } catch (ActivityNotFoundException e) {
            startActivity(new Intent(Settings.ACTION_SETTINGS));
        }
    }

    private String defaultDeviceName() {
        String n = null;
        try {
            n = Settings.Global.getString(getContentResolver(), Settings.Global.DEVICE_NAME);
        } catch (Exception ignored) {
        }
        return n == null || n.isEmpty() ? Build.MODEL : n;
    }

    private static String text(TextInputEditText e) {
        return e.getText() == null ? "" : e.getText().toString().trim();
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_LONG).show();
    }
}
