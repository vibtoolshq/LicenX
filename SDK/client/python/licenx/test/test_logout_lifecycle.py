import signal
import unittest
from unittest.mock import MagicMock, Mock, patch

from licenx.device import DeviceManager
from licenx.logout import LogoutManager


class LogoutLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.communicator = Mock()
        self.storage = Mock()

    @staticmethod
    def _registered_signal_handlers(signal_set):
        return {
            call.args[0]: call.args[1]
            for call in signal_set.call_args_list
        }

    def test_previous_handlers_run_and_exit_cleanup_runs_once(self):
        previous_handlers = {
            signal.SIGINT: Mock(),
            signal.SIGTERM: Mock(),
        }
        with patch(
            "licenx.logout.signal.getsignal",
            side_effect=previous_handlers.get,
        ), patch("licenx.logout.signal.signal") as signal_set, patch(
            "licenx.logout.atexit.register"
        ) as register_exit, patch.object(
            DeviceManager, "get_hwid", return_value="test-hwid"
        ):
            manager = LogoutManager(self.communicator, self.storage)
            manager.set_active_session("test-license")
            handlers = self._registered_signal_handlers(signal_set)
            frame = object()

            handlers[signal.SIGINT](signal.SIGINT, frame)
            handlers[signal.SIGTERM](signal.SIGTERM, frame)
            register_exit.call_args.args[0]()

        previous_handlers[signal.SIGINT].assert_called_once_with(signal.SIGINT, frame)
        previous_handlers[signal.SIGTERM].assert_called_once_with(signal.SIGTERM, frame)
        self.communicator.send_logout.assert_called_once_with(
            "test-license", "test-hwid"
        )

    def test_default_and_ignored_handlers_keep_their_signal_semantics(self):
        previous_handlers = {
            signal.SIGINT: signal.SIG_DFL,
            signal.SIGTERM: signal.SIG_IGN,
        }
        with patch(
            "licenx.logout.signal.getsignal",
            side_effect=previous_handlers.get,
        ), patch("licenx.logout.signal.signal") as signal_set, patch(
            "licenx.logout.atexit.register"
        ), patch("licenx.logout.os.getpid", return_value=123), patch(
            "licenx.logout.os.kill"
        ) as kill_signal, patch.object(
            DeviceManager, "get_hwid", return_value="test-hwid"
        ):
            manager = LogoutManager(self.communicator, self.storage)
            manager.set_active_session("test-license")
            handlers = self._registered_signal_handlers(signal_set)

            handlers[signal.SIGTERM](signal.SIGTERM, None)
            self.communicator.send_logout.assert_not_called()
            handlers[signal.SIGINT](signal.SIGINT, None)

        signal_set.assert_any_call(signal.SIGINT, signal.SIG_DFL)
        kill_signal.assert_called_once_with(123, signal.SIGINT)
        self.communicator.send_logout.assert_called_once_with(
            "test-license", "test-hwid"
        )

    def test_verified_validation_strips_logout_proof_from_public_result(self):
        from licenx.config import SDKConfig
        from licenx.server import ServerCommunicator
        communicator = ServerCommunicator(SDKConfig(
            server_url="https://licenx.test", app_name="test-app", app_version="1.0.0",
        ))
        signed_data = {
            "valid": True, "nonce": "test-nonce", "request_app": "test-app",
            "license_key": "LIC-TEST", "hwid": "HWID-TEST",
            "device_logout_proof": "A" * 43, "signature": "test-signature",
        }
        with patch("licenx.server.secrets.token_urlsafe", return_value="test-nonce"), patch.object(
            communicator, "_http_post", return_value=(200, signed_data.copy())
        ) as http, patch.object(communicator, "verify_signature", return_value=True):
            ok, status, result = communicator.validate_license(
                "LIC-TEST", "HWID-TEST", {}
            )
        self.assertTrue(ok)
        self.assertEqual(status, 200)
        self.assertNotIn("device_logout_proof", result)
        self.assertEqual(communicator._logout_proof_session, ("LIC-TEST", "HWID-TEST"))
        self.assertEqual(communicator._logout_proof, "A" * 43)
        self.assertEqual(http.call_args.args[1]["logout_proof_version"], 2)

    def test_proof_bound_v2_logout_only_and_no_legacy_fallback(self):
        from licenx.config import SDKConfig
        from licenx.server import ServerCommunicator
        communicator = ServerCommunicator(SDKConfig(server_url="https://licenx.test"))
        communicator._logout_proof = "A" * 43
        communicator._logout_proof_session = ("LIC-TEST", "HWID-TEST")
        response = MagicMock()
        response.getcode.return_value = 200
        response.__enter__.return_value = response
        with patch("licenx.server.urllib.request.urlopen", return_value=response) as send:
            self.assertTrue(communicator.send_logout("lic-test", "HWID-TEST"))
        request = send.call_args.args[0]
        self.assertEqual(request.full_url, "https://licenx.test/api/v2/license/logout")
        self.assertEqual(request.get_header("Authorization"), "Bearer " + "A" * 43)
        self.assertIsNone(communicator._logout_proof)
        with patch.object(communicator, "ping_heartbeat", return_value=(False, {})), patch(
            "licenx.server.urllib.request.urlopen"
        ) as no_anonymous:
            self.assertFalse(communicator.send_logout("LIC-TEST", "HWID-TEST"))
            no_anonymous.assert_not_called()

    def test_expired_v2_proof_refreshes_only_via_signed_heartbeat(self):
        from urllib.error import HTTPError
        from licenx.config import SDKConfig
        from licenx.server import ServerCommunicator
        communicator = ServerCommunicator(SDKConfig(server_url="https://licenx.test"))
        communicator._logout_proof = "A" * 43
        communicator._logout_proof_session = ("LIC-TEST", "HWID-TEST")
        response = MagicMock()
        response.getcode.return_value = 200
        response.__enter__.return_value = response

        def refresh(key, hwid):
            communicator._logout_proof = "B" * 43
            return True, {"valid": True}

        with patch("licenx.server.urllib.request.urlopen", side_effect=[
            HTTPError("https://licenx.test/api/v2/license/logout", 403, "expired", {}, None),
            response,
        ]) as send, patch.object(communicator, "ping_heartbeat", side_effect=refresh) as ping:
            self.assertTrue(communicator.send_logout("LIC-TEST", "HWID-TEST"))
        ping.assert_called_once_with("LIC-TEST", "HWID-TEST")
        self.assertEqual(send.call_count, 2)
        self.assertEqual(send.call_args.args[0].get_header("Authorization"), "Bearer " + "B" * 43)

    def test_disabling_exit_hooks_does_not_change_host_signal_handlers(self):
        with patch("licenx.logout.signal.getsignal") as get_signal, patch(
            "licenx.logout.signal.signal"
        ) as set_signal, patch("licenx.logout.atexit.register") as register_exit:
            LogoutManager(self.communicator, self.storage, auto_logout_on_exit=False)

        get_signal.assert_not_called()
        set_signal.assert_not_called()
        register_exit.assert_not_called()


    def test_failed_v2_release_from_exit_is_once_only_and_never_fakes_success(self):
        from licenx.config import SDKConfig
        self.assertTrue(SDKConfig().auto_logout_on_exit)
        previous_handler = Mock()
        self.communicator.send_logout.side_effect = OSError("PRIVATE NETWORK")
        with patch("licenx.logout.signal.getsignal", return_value=previous_handler), \
             patch("licenx.logout.signal.signal") as set_signal, \
             patch("licenx.logout.atexit.register") as register_exit:
            manager = LogoutManager(self.communicator, self.storage)
            manager.set_active_session("SYNTHETIC-KEY", "ORIGINAL-HWID")
            callbacks = self._registered_signal_handlers(set_signal)
            callbacks[signal.SIGTERM](signal.SIGTERM, None)
            register_exit.call_args.args[0]()
        previous_handler.assert_called_once_with(signal.SIGTERM, None)
        self.communicator.send_logout.assert_called_once_with(
            "SYNTHETIC-KEY", "ORIGINAL-HWID",
        )
        self.assertTrue(manager.has_pending_release())
        self.assertIsNone(manager._current_license_key)
        self.assertEqual(manager._pending_release, ("SYNTHETIC-KEY", "ORIGINAL-HWID"))

if __name__ == "__main__":
    unittest.main()
