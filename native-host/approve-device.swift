// Asks the person at this Mac to approve a new remote device, with Touch ID or the login password.
//
//   approve-device <reason> [seconds]
//
// Exit 0 approved, 1 refused or cancelled, 2 nobody answered in time, 3 this Mac cannot ask.
// macOS shows the dialog itself, so nothing here can be clicked by another program: approving
// takes a finger on the sensor, or the password. See docs/17-remote-access.md.
import Foundation
import LocalAuthentication

let args = CommandLine.arguments
let reason = args.count > 1 ? args[1] : "approve a new device for remote access"
let seconds = args.count > 2 ? Double(args[2]) ?? 90 : 90
let context = LAContext()
var error: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
  exit(3)
}
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in
  exit(ok ? 0 : 1)
}
DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
  context.invalidate()
  exit(2)
}
dispatchMain()
