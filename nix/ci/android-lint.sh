install_dependencies
step android-sync 'Build web assets and sync Capacitor' pnpm android:sync
step android-lint 'Android lint' bash -c 'cd android && gradle --no-daemon lintDebug'
