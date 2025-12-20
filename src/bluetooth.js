// Bluetooth Serial functions for HC-05 module
// This uses cordova-plugin-bluetooth-serial which exposes bluetoothSerial globally

/**
 * List paired Bluetooth devices
 * @returns {Promise<Array>} Array of paired devices with {name, address, id}
 */
export function listPairedDevices() {
  return new Promise((resolve, reject) => {
    if (typeof bluetoothSerial === 'undefined') {
      reject(new Error('Bluetooth Serial not available - run on device'));
      return;
    }
    bluetoothSerial.list(
      devices => resolve(devices),
      err => reject(err)
    );
  });
}

/**
 * Ensure Android 12+ Bluetooth and Location runtime permissions are granted
 * Requires cordova-plugin-android-permissions
 * @returns {Promise<boolean>} true if permissions granted
 */
export function ensureBtPermissions() {
  return new Promise((resolve) => {
    const permissions = window.cordova && window.cordova.plugins && window.cordova.plugins.permissions
    if (!permissions) {
      // If plugin missing, proceed (older Android may not require runtime requests)
      resolve(true)
      return
    }

    const required = [
      permissions.BLUETOOTH,
      permissions.BLUETOOTH_ADMIN,
      permissions.BLUETOOTH_CONNECT, // Android 12+
      permissions.BLUETOOTH_SCAN,    // Android 12+
      permissions.ACCESS_FINE_LOCATION,
      permissions.ACCESS_COARSE_LOCATION
    ].filter(Boolean)

    // Request all at once
    try {
      permissions.requestPermissions(required, (status) => {
        const granted = status && status.hasPermission !== false
        resolve(!!granted)
      }, (_err) => {
        resolve(false)
      })
    } catch (_e) {
      resolve(false)
    }
  })
}

/**
 * Check if Bluetooth is enabled
 * @returns {Promise<boolean>}
 */
export function isBluetoothEnabled() {
  return new Promise((resolve, reject) => {
    if (typeof bluetoothSerial === 'undefined') {
      reject(new Error('Bluetooth Serial not available - run on device'));
      return;
    }
    bluetoothSerial.isEnabled(
      () => resolve(true),
      () => resolve(false)
    );
  });
}

/**
 * Prompt to enable Bluetooth if disabled
 * @returns {Promise<boolean>}
 */
export function enableBluetooth() {
  return new Promise((resolve) => {
    if (typeof bluetoothSerial === 'undefined') { resolve(false); return }
    try {
      // Some versions support enable() to prompt user
      if (bluetoothSerial.enable) {
        bluetoothSerial.enable(() => resolve(true), () => resolve(false))
      } else {
        resolve(false)
      }
    } catch (_e) {
      resolve(false)
    }
  })
}

/**
 * Connect to HC-05 by MAC address
 * @param {string} mac - MAC address of HC-05 (e.g., "00:21:13:01:AA:BB")
 * @returns {Promise<void>}
 */
export function connectHC05(mac) {
  return new Promise((resolve, reject) => {
    if (typeof bluetoothSerial === 'undefined') {
      reject(new Error('Bluetooth Serial not available - run on device'));
      return;
    }
    bluetoothSerial.connect(
      mac,
      () => {
        console.log("HC-05 Connected");
        resolve();
      },
      err => {
        console.error("Connect error", err);
        reject(err);
      }
    );
  });
}

/**
 * Start reading data from HC-05
 * @param {function} onData - Callback function that receives data string
 */
export function startReading(onData) {
  if (typeof bluetoothSerial === 'undefined') {
    console.error('Bluetooth Serial not available - run on device');
    return;
  }
  bluetoothSerial.subscribe('\n', data => {
    onData(data.trim());
  });
}

/**
 * Stop reading data from HC-05
 */
export function stopReading() {
  if (typeof bluetoothSerial === 'undefined') {
    console.error('Bluetooth Serial not available - run on device');
    return;
  }
  bluetoothSerial.unsubscribe();
}

/**
 * Write data to HC-05
 * @param {string} data - Data to send
 * @returns {Promise<void>}
 */
export function writeData(data) {
  return new Promise((resolve, reject) => {
    if (typeof bluetoothSerial === 'undefined') {
      reject(new Error('Bluetooth Serial not available - run on device'));
      return;
    }
    bluetoothSerial.write(
      data,
      () => resolve(),
      err => reject(err)
    );
  });
}

/**
 * Disconnect from HC-05
 * @returns {Promise<void>}
 */
export function disconnect() {
  return new Promise((resolve, reject) => {
    if (typeof bluetoothSerial === 'undefined') {
      reject(new Error('Bluetooth Serial not available - run on device'));
      return;
    }
    bluetoothSerial.disconnect(
      () => {
        console.log("HC-05 Disconnected");
        resolve();
      },
      err => reject(err)
    );
  });
}

/**
 * Check if currently connected
 * @returns {Promise<boolean>}
 */
export function isConnected() {
  return new Promise((resolve) => {
    if (typeof bluetoothSerial === 'undefined') {
      resolve(false);
      return;
    }
    bluetoothSerial.isConnected(
      () => resolve(true),
      () => resolve(false)
    );
  });
}
