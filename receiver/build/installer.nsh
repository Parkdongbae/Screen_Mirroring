; 설치 시 Windows 방화벽 허용 규칙을 추가하고, 삭제 시 제거한다(FR-16).
; 교내망(도메인·사설 프로필)에서만 허용한다.

!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="ScreenMirrorReceiver"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="ScreenMirrorReceiver" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes profile=domain,private'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="ScreenMirrorReceiver"'
!macroend
