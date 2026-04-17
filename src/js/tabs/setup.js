import { i18n } from "../localization";
import semver from "semver";
import { isExpertModeEnabled } from "../utils/isExpertModeEnabled";
import GUI, { TABS } from "../gui";
import { have_sensor } from "../sensor_helpers";
import { mspHelper } from "../msp/MSPHelper";
import FC from "../fc";
import MSP from "../msp";
import Model from "../model";
import MSPCodes from "../msp/MSPCodes";
import { API_VERSION_1_45, API_VERSION_1_46, API_VERSION_1_47 } from "../data_storage";
import FileSystem from "../FileSystem";
import { gui_log } from "../gui_log";
import { initializeModalDialog } from "../utils/initializeModalDialog";
import { reinitializeConnection } from "../serial_backend";
import $ from "jquery";
import { getMixerImageSrc } from "../utils/common";
import { VtxDeviceTypes } from "../utils/VtxDeviceStatus/VtxDeviceStatus";

const setup = {
    yaw_fix: 0.0,
};

setup.initialize = function (callback) {
    const self = this;

    if (GUI.active_tab != "setup") {
        GUI.active_tab = "setup";
    }

    function load_status() {
        MSP.send_message(MSPCodes.MSP_STATUS_EX, false, false, load_mixer_config);
    }

    function load_mixer_config() {
        MSP.send_message(MSPCodes.MSP_MIXER_CONFIG, false, false, load_motor_config);
    }

    function load_motor_config() {
        MSP.send_message(MSPCodes.MSP_MOTOR_CONFIG, false, false, load_gyro_sensor);
    }

    function load_gyro_sensor() {
        MSP.send_message(MSPCodes.MSP_SENSOR_ALIGNMENT, false, false, load_rc);
    }

    function load_rc() {
        MSP.send_message(MSPCodes.MSP_RC, false, false, load_vtx_config);
    }

    function load_vtx_config() {
        MSP.send_message(MSPCodes.MSP_VTX_CONFIG, false, false, load_blackbox_config);
    }

    function load_blackbox_config() {
        MSP.send_message(MSPCodes.MSP_BLACKBOX_CONFIG, false, false, load_dataflash);
    }

    function load_dataflash() {
        MSP.send_message(MSPCodes.MSP_DATAFLASH_SUMMARY, false, false, load_sdcard);
    }

    function load_sdcard() {
        MSP.send_message(MSPCodes.MSP_SDCARD_SUMMARY, false, false, load_vtx_table_bands);
    }

    // Load VTX table bands recursively
    self._vtxBandList = [];
    self._vtxPowerLevelList = [];

    function load_vtx_table_bands() {
        const numBands = FC.VTX_CONFIG.vtx_table_bands;
        if (!FC.VTX_CONFIG.vtx_table_available || numBands === 0) {
            load_vtx_table_powerlevels();
            return;
        }
        let counter = 1;
        function nextBand() {
            if (counter > numBands) {
                load_vtx_table_powerlevels();
                return;
            }
            const buf = [];
            buf.push(counter);
            MSP.send_message(MSPCodes.MSP_VTXTABLE_BAND, buf, false, function () {
                self._vtxBandList.push(Object.assign({}, FC.VTXTABLE_BAND));
                counter++;
                nextBand();
            });
        }
        nextBand();
    }

    function load_vtx_table_powerlevels() {
        const numPower = FC.VTX_CONFIG.vtx_table_powerlevels;
        if (!FC.VTX_CONFIG.vtx_table_available || numPower === 0) {
            load_html();
            return;
        }
        let counter = 1;
        function nextPower() {
            if (counter > numPower) {
                load_html();
                return;
            }
            const buf = [];
            buf.push(counter);
            MSP.send_message(MSPCodes.MSP_VTXTABLE_POWERLEVEL, buf, false, function () {
                self._vtxPowerLevelList.push(Object.assign({}, FC.VTXTABLE_POWERLEVEL));
                counter++;
                nextPower();
            });
        }
        nextPower();
    }

    function load_html() {
        $("#content").load("./tabs/setup.html", process_html);
    }

    MSP.send_message(MSPCodes.MSP_ACC_TRIM, false, false, load_status);

    function process_html() {
        // translate to user-selected language
        i18n.localizePage();

        // initialize 3D Model
        self.initModel();

        // set roll in interactive block
        $("span.roll").text(i18n.getMessage("initialSetupAttitude", [0]));
        // set pitch in interactive block
        $("span.pitch").text(i18n.getMessage("initialSetupAttitude", [0]));
        // set heading in interactive block
        $("span.heading").text(i18n.getMessage("initialSetupAttitude", [0]));

        // check if we have accelerometer and magnetometer
        if (!have_sensor(FC.CONFIG.activeSensors, "acc")) {
            $("a.calibrateAccel").addClass("disabled");
            $("default_btn").addClass("disabled");
        }

        if (!have_sensor(FC.CONFIG.activeSensors, "mag")) {
            $("a.calibrateMag").addClass("disabled");
            $("default_btn").addClass("disabled");
        }

        $("#arming-disable-flag").attr("title", i18n.getMessage("initialSetupArmingDisableFlagsTooltip"));

        $(".initialSetupRebootBootloader").toggle(isExpertModeEnabled());

        $("a.rebootBootloader").click(function () {
            const buffer = [];
            buffer.push(
                FC.boardHasFlashBootloader()
                    ? mspHelper.REBOOT_TYPES.BOOTLOADER_FLASH
                    : mspHelper.REBOOT_TYPES.BOOTLOADER,
            );
            MSP.send_message(MSPCodes.MSP_SET_REBOOT, buffer, false);
        });

        // UI Hooks
        $("a.calibrateAccel").click(function () {
            const _self = $(this);

            if (!_self.hasClass("calibrating")) {
                _self.addClass("calibrating");

                GUI.interval_pause("setup_data_pull");
                MSP.send_message(MSPCodes.MSP_ACC_CALIBRATION, false, false, function () {
                    gui_log(i18n.getMessage("initialSetupAccelCalibStarted"));
                    $("#accel_calib_running").show();
                    $("#accel_calib_rest").hide();
                });

                GUI.timeout_add(
                    "button_reset",
                    function () {
                        GUI.interval_resume("setup_data_pull");

                        gui_log(i18n.getMessage("initialSetupAccelCalibEnded"));
                        _self.removeClass("calibrating");
                        $("#accel_calib_running").hide();
                        $("#accel_calib_rest").show();
                    },
                    2000,
                );
            }
        });

        $("a.calibrateMag").click(function () {
            const _self = $(this);

            if (!_self.hasClass("calibrating") && !_self.hasClass("disabled")) {
                _self.addClass("calibrating");

                MSP.send_message(MSPCodes.MSP_MAG_CALIBRATION, false, false, function () {
                    gui_log(i18n.getMessage("initialSetupMagCalibStarted"));
                    $("#mag_calib_running").show();
                    $("#mag_calib_rest").hide();
                });

                function magCalibResetButton() {
                    gui_log(i18n.getMessage("initialSetupMagCalibEnded"));
                    _self.removeClass("calibrating");
                    $("#mag_calib_running").hide();
                    $("#mag_calib_rest").show();
                }

                if (semver.gte(FC.CONFIG.apiVersion, API_VERSION_1_46)) {
                    let cycle = 0;
                    const cycleMax = 45;
                    const interval = 1000;
                    const intervalId = setInterval(function () {
                        if (cycle >= cycleMax || (FC.CONFIG.armingDisableFlags & (1 << 12)) === 0) {
                            clearInterval(intervalId);
                            magCalibResetButton();
                        }
                        cycle++;
                    }, interval);
                } else {
                    GUI.timeout_add("button_reset", magCalibResetButton, 30000);
                }
            }
        });

        const dialogConfirmReset = $(".dialogConfirmReset")[0];

        $("a.resetSettings").click(function () {
            dialogConfirmReset.showModal();
        });

        $(".dialogConfirmReset-cancelbtn").click(function () {
            dialogConfirmReset.close();
        });

        $(".dialogConfirmReset-confirmbtn").click(function () {
            dialogConfirmReset.close();
            MSP.send_message(MSPCodes.MSP_RESET_CONF, false, false, function () {
                gui_log(i18n.getMessage("initialSetupSettingsRestored"));

                GUI.tab_switch_cleanup(function () {
                    TABS.setup.initialize();
                });
            });
        });

        // display current yaw fix value
        $("div#interactive_block > a.reset").text(i18n.getMessage("initialSetupButtonResetZaxisValue", [self.yaw_fix]));

        // reset yaw button hook
        $("div#interactive_block > a.reset").click(function () {
            self.yaw_fix = FC.SENSOR_DATA.kinematics[2] * -1.0;
            $(this).text(i18n.getMessage("initialSetupButtonResetZaxisValue", [self.yaw_fix]));

            console.log(`YAW reset to 0 deg, fix: ${self.yaw_fix} deg`);
        });

        // ---- Motor Direction Test ----
        self.initMotorDirectionTest();

        // ---- Motor RPM / Test Mode ----
        self.initMotorRpm();

        // ---- RC Channel Bars ----
        self.initRcBars();

        // ---- Blackbox Device ----
        self.initBlackboxDevice();

        // ---- VTX Status + Frequency Table ----
        self.initVtxStatus();

        // ---- Pilot / Craft Name + Font Upload ----
        self.initNamesAndFont();

        // cached elements
        const bat_voltage_e = $(".bat-voltage"),
            bat_mah_drawn_e = $(".bat-mah-drawn"),
            bat_mah_drawing_e = $(".bat-mah-drawing"),
            rssi_e = $(".rssi"),
            cputemp_e = $(".cpu-temp"),
            arming_disable_flags_e = $(".arming-disable-flags"),
            roll_e = $("dd.roll"),
            pitch_e = $("dd.pitch"),
            heading_e = $("dd.heading");

        // DISARM FLAGS
        const prepareDisarmFlags = function () {
            let disarmFlagElements = [
                "NO_GYRO",
                "FAILSAFE",
                "RX_FAILSAFE",
                "NOT_DISARMED",
                "BOXFAILSAFE",
                "RUNAWAY_TAKEOFF",
                "CRASH_DETECTED",
                "THROTTLE",
                "ANGLE",
                "BOOT_GRACE_TIME",
                "NOPREARM",
                "LOAD",
                "CALIBRATING",
                "CLI",
                "CMS_MENU",
                "BST",
                "MSP",
                "PARALYZE",
                "GPS",
                "RESC",
                "RPMFILTER",
                "REBOOT_REQUIRED",
                "DSHOT_BITBANG",
                "ACC_CALIBRATION",
                "MOTOR_PROTOCOL",
            ];

            if (semver.gte(FC.CONFIG.apiVersion, API_VERSION_1_46)) {
                const idx = disarmFlagElements.indexOf("RPMFILTER");
                if (idx !== -1) disarmFlagElements[idx] = "DSHOT_TELEM";
            }

            if (semver.gte(FC.CONFIG.apiVersion, API_VERSION_1_47)) {
                const idx = disarmFlagElements.indexOf("MOTOR_PROTOCOL");
                if (idx !== -1) {
                    disarmFlagElements.splice(idx + 1, 0, "CRASHFLIP", "ALTHOLD", "POSHOLD");
                }
            }

            arming_disable_flags_e.append(
                '<span id="initialSetupArmingAllowed" i18n="initialSetupArmingAllowed" style="display: none;"></span>',
            );

            for (let i = 0; i < FC.CONFIG.armingDisableCount; i++) {
                if (i < disarmFlagElements.length - 1) {
                    const messageKey = `initialSetupArmingDisableFlagsTooltip${disarmFlagElements[i]}`;
                    arming_disable_flags_e.append(
                        `<span id="initialSetupArmingDisableFlags${i}" class="cf_tip disarm-flag" title="${i18n.getMessage(
                            messageKey,
                        )}" style="display: none;">${disarmFlagElements[i]}</span>`,
                    );
                } else if (i == FC.CONFIG.armingDisableCount - 1) {
                    arming_disable_flags_e.append(
                        `<span id="initialSetupArmingDisableFlags${i}" class="cf_tip disarm-flag" title="${i18n.getMessage(
                            "initialSetupArmingDisableFlagsTooltipARM_SWITCH",
                        )}" style="display: none;">ARM_SWITCH</span>`,
                    );
                } else {
                    arming_disable_flags_e.append(
                        `<span id="initialSetupArmingDisableFlags${i}" class="disarm-flag" style="display: none;">${
                            i + 1
                        }</span>`,
                    );
                }
            }
        };

        prepareDisarmFlags();

        function get_slow_data() {
            $("#initialSetupArmingAllowed").toggle(FC.CONFIG.armingDisableFlags === 0);

            for (let i = 0; i < FC.CONFIG.armingDisableCount; i++) {
                $(`#initialSetupArmingDisableFlags${i}`).css(
                    "display",
                    (FC.CONFIG.armingDisableFlags & (1 << i)) === 0 ? "none" : "inline-block",
                );
            }

            bat_voltage_e.text(i18n.getMessage("initialSetupBatteryValue", [FC.ANALOG.voltage]));
            bat_mah_drawn_e.text(i18n.getMessage("initialSetupBatteryMahValue", [FC.ANALOG.mAhdrawn]));
            bat_mah_drawing_e.text(i18n.getMessage("initialSetupBatteryAValue", [FC.ANALOG.amperage.toFixed(2)]));
            rssi_e.text(i18n.getMessage("initialSetupRSSIValue", [((FC.ANALOG.rssi / 1023) * 100).toFixed(0)]));

            if (semver.gte(FC.CONFIG.apiVersion, API_VERSION_1_46) && FC.CONFIG.cpuTemp) {
                cputemp_e.html(`${FC.CONFIG.cpuTemp.toFixed(0)} &#8451;`);
            } else {
                cputemp_e.text(i18n.getMessage("initialSetupCpuTempNotSupported"));
            }
        }

        function get_fast_data() {
            MSP.send_message(MSPCodes.MSP_ATTITUDE, false, false, function () {
                roll_e.text(i18n.getMessage("initialSetupAttitude", [FC.SENSOR_DATA.kinematics[0]]));
                pitch_e.text(i18n.getMessage("initialSetupAttitude", [FC.SENSOR_DATA.kinematics[1]]));
                heading_e.text(i18n.getMessage("initialSetupAttitude", [FC.SENSOR_DATA.kinematics[2]]));

                self.renderModel();
            });

            // Update RC bars
            MSP.send_message(MSPCodes.MSP_RC, false, false, function () {
                self.updateRcBars();
            });

            // Update motor values + telemetry
            MSP.send_message(MSPCodes.MSP_MOTOR, false, false, function () {
                if (FC.MOTOR_CONFIG.use_dshot_telemetry || FC.MOTOR_CONFIG.use_esc_sensor) {
                    MSP.send_message(MSPCodes.MSP_MOTOR_TELEMETRY, false, false, function () {
                        self.updateMotorRpm();
                    });
                } else {
                    self.updateMotorRpm();
                }
            });
        }

        GUI.interval_add("setup_data_pull_fast", get_fast_data, 33, true); // 30 fps
        GUI.interval_add("setup_data_pull_slow", get_slow_data, 250, true); // 4 fps

        // VTX status polling (every 1s)
        GUI.interval_add(
            "setup_vtx_pull",
            function () {
                MSP.send_message(MSPCodes.MSP2_GET_VTX_DEVICE_STATUS, false, false, function () {
                    self.updateVtxStatus();
                });
            },
            1000,
            true,
        );

        GUI.content_ready(callback);
    }
};

// ---- Motor Direction Test ----
setup.initMotorDirectionTest = function () {
    const mixerIndex = FC.MIXER_CONFIG.mixer;
    const reverseMotorDir = FC.MIXER_CONFIG.reverseMotorDir;

    // Load mixer SVG inline (same approach as motors tab)
    if (mixerIndex > 0) {
        const imgSrc = getMixerImageSrc(mixerIndex, reverseMotorDir);
        $.get(
            imgSrc,
            function (data) {
                const svg = $(data).find("svg");
                $(".motor-direction-box .mixerPreview").html(svg);
            },
            "xml",
        );
    }

    const motorCount = FC.MOTOR_CONFIG.motor_count;
    const wrapper = $("#motorDirectionButtonsWrapper");
    wrapper.empty();

    let isDragging = false;
    let activeMotor = -1;

    function sendMotor(motorIndex) {
        if (motorIndex === activeMotor) return;
        activeMotor = motorIndex;
        const mspBuffer = [];
        for (let m = 0; m < motorCount; m++) {
            const val = m === motorIndex ? FC.MOTOR_CONFIG.mincommand + 50 : FC.MOTOR_CONFIG.mincommand;
            mspBuffer.push(val & 0xff);
            mspBuffer.push((val >> 8) & 0xff);
        }
        MSP.send_message(MSPCodes.MSP_SET_MOTOR, mspBuffer, false);
    }

    function stopAllMotors() {
        activeMotor = -1;
        const mspBuffer = [];
        for (let m = 0; m < motorCount; m++) {
            const val = FC.MOTOR_CONFIG.mincommand;
            mspBuffer.push(val & 0xff);
            mspBuffer.push((val >> 8) & 0xff);
        }
        MSP.send_message(MSPCodes.MSP_SET_MOTOR, mspBuffer, false);
    }

    for (let i = 0; i < motorCount; i++) {
        const btn = $(`<a href="#" class="regular-button" data-motor="${i}">Motor ${i + 1}</a>`);

        btn.on("mousedown touchstart", function (e) {
            e.preventDefault();
            isDragging = true;
            sendMotor(i);
        });

        btn.on("mouseenter", function () {
            if (isDragging) {
                sendMotor(i);
            }
        });

        wrapper.append(btn);
    }

    $(document).on("mouseup.motortest touchend.motortest", function () {
        if (isDragging) {
            isDragging = false;
            stopAllMotors();
        }
    });
};

// ---- Motor RPM / Test Mode ----
setup.initMotorRpm = function () {
    const self = this;
    const motorCount = FC.MOTOR_CONFIG.motor_count;
    const barsContainer = $(".motor-rpm-bars");
    barsContainer.empty();

    self._motorTestEnabled = false;

    const hasTelemetry = FC.MOTOR_CONFIG.use_dshot_telemetry || FC.MOTOR_CONFIG.use_esc_sensor;
    const rangeMin = FC.MOTOR_CONFIG.mincommand;
    const rangeMax = FC.MOTOR_CONFIG.maxthrottle;

    for (let i = 0; i < motorCount; i++) {
        barsContainer.append(`
            <div class="motor-rpm-row">
                <span class="motor-rpm-name">M${i + 1}</span>
                <span class="motor-status-dot" data-motor="${i}" title="No data"></span>
                <div class="motor-rpm-bar">
                    <div class="motor-rpm-fill" data-motor="${i}"></div>
                </div>
                <span class="motor-rpm-value" data-motor="${i}">0</span>
                ${hasTelemetry ? `<span class="motor-rpm-telemetry" data-motor="${i}">- RPM</span>` : ""}
            </div>
            <div class="motor-slider-row" style="display:none;">
                <span class="motor-rpm-name">M${i + 1}</span>
                <input type="range" class="motor-slider" data-motor="${i}" min="${rangeMin}" max="${rangeMax}" value="${rangeMin}" disabled/>
                <span class="motor-slider-value" data-motor="${i}">${rangeMin}</span>
            </div>
        `);
    }

    // Master slider
    barsContainer.append(`
        <div class="motor-slider-row master-slider-row" style="display:none;">
            <span class="motor-rpm-name" style="font-weight:700;">All</span>
            <input type="range" class="motor-slider master-slider" min="${rangeMin}" max="${rangeMax}" value="${rangeMin}" disabled/>
            <span class="motor-slider-value master-slider-value">${rangeMin}</span>
        </div>
    `);

    self._rpmFills = barsContainer.find(".motor-rpm-fill");
    self._rpmValues = barsContainer.find(".motor-rpm-value");
    self._rpmTelemetry = hasTelemetry ? barsContainer.find(".motor-rpm-telemetry") : null;
    self._statusDots = barsContainer.find(".motor-status-dot");
    self._hasTelemetry = hasTelemetry;
    self._motorSliders = barsContainer.find(".motor-slider:not(.master-slider)");
    self._masterSlider = barsContainer.find(".master-slider");
    self._motorSliderValues = barsContainer.find(".motor-slider-value:not(.master-slider-value)");
    self._masterSliderValue = barsContainer.find(".master-slider-value");

    // Debounced MSP_SET_MOTOR send
    let sendBuffer = null;
    let sendTimeout = null;

    function sendMotorValues() {
        const mspBuffer = [];
        for (let m = 0; m < motorCount; m++) {
            const val = parseInt($(self._motorSliders[m]).val());
            mspBuffer.push(val & 0xff);
            mspBuffer.push((val >> 8) & 0xff);
        }
        MSP.send_message(MSPCodes.MSP_SET_MOTOR, mspBuffer, false);
    }

    function debouncedSend() {
        if (sendTimeout) return;
        sendTimeout = setTimeout(function () {
            sendMotorValues();
            sendTimeout = null;
        }, 10);
    }

    // Individual slider input
    self._motorSliders.on("input", function () {
        const idx = $(this).data("motor");
        $(self._motorSliderValues[idx]).text($(this).val());
        debouncedSend();
    });

    // Master slider input
    self._masterSlider.on("input", function () {
        const val = $(this).val();
        self._masterSliderValue.text(val);
        self._motorSliders.val(val);
        self._motorSliderValues.text(val);
        debouncedSend();
    });

    const checkbox = $("#setupMotorsEnableTestMode");
    const stopBtn = $(".stop-motors-btn");
    const sliderRows = barsContainer.find(".motor-slider-row");

    function setSlidersEnabled(enabled) {
        if (enabled) {
            sliderRows.show();
            self._motorSliders.prop("disabled", false);
            self._masterSlider.prop("disabled", false);
        } else {
            // Reset sliders to min
            self._motorSliders.val(rangeMin);
            self._masterSlider.val(rangeMin);
            self._motorSliderValues.text(rangeMin);
            self._masterSliderValue.text(rangeMin);
            self._motorSliders.prop("disabled", true);
            self._masterSlider.prop("disabled", true);
            sliderRows.hide();
        }
    }

    stopBtn.on("click", function (e) {
        e.preventDefault();
        checkbox.prop("checked", false).trigger("change");
    });

    checkbox.on("change", function () {
        const enabled = $(this).is(":checked");
        self._motorTestEnabled = enabled;
        mspHelper.setArmingEnabled(enabled, enabled);
        setSlidersEnabled(enabled);
        if (!enabled) {
            // Send min command to all motors
            const mspBuffer = [];
            for (let m = 0; m < motorCount; m++) {
                const val = rangeMin;
                mspBuffer.push(val & 0xff);
                mspBuffer.push((val >> 8) & 0xff);
            }
            MSP.send_message(MSPCodes.MSP_SET_MOTOR, mspBuffer, false);
        }
        stopBtn.toggleClass("disabled", !enabled);
    });

    stopBtn.addClass("disabled");
};

setup.updateMotorRpm = function () {
    if (!this._rpmFills) return;

    const motorCount = FC.MOTOR_CONFIG.motor_count;
    const minValue = FC.MOTOR_CONFIG.mincommand;
    const maxValue = FC.MOTOR_CONFIG.maxthrottle;
    const range = maxValue - minValue;

    for (let i = 0; i < motorCount; i++) {
        const value = FC.MOTOR_DATA[i] || 0;
        const percent = range > 0 ? Math.max(0, Math.min(100, ((value - minValue) / range) * 100)) : 0;

        $(this._rpmFills[i]).css("width", `${percent}%`);
        $(this._rpmValues[i]).text(value);

        if (this._rpmTelemetry) {
            const rpm = FC.MOTOR_TELEMETRY_DATA.rpm[i] || 0;
            const invalidPct = FC.MOTOR_TELEMETRY_DATA.invalidPercent[i] || 0;
            $(this._rpmTelemetry[i]).text(`${rpm} RPM`);

            // Status: red if no telemetry or high error rate, green if RPM>0, grey if idle
            const dot = $(this._statusDots[i]);
            if (invalidPct > 50 || (value > minValue + 50 && rpm === 0)) {
                dot.attr("class", "motor-status-dot status-error").attr(
                    "title",
                    rpm === 0 ? "No telemetry" : `Errors: ${invalidPct}%`,
                );
            } else if (rpm > 0) {
                dot.attr("class", "motor-status-dot status-ok").attr("title", `${rpm} RPM`);
            } else {
                dot.attr("class", "motor-status-dot status-idle").attr("title", "Idle");
            }
        } else {
            // No telemetry capability — indicate based on motor value
            const dot = $(this._statusDots[i]);
            if (value > minValue + 50) {
                dot.attr("class", "motor-status-dot status-ok").attr("title", "Running");
            } else {
                dot.attr("class", "motor-status-dot status-idle").attr("title", "Idle");
            }
        }
    }
};

// ---- RC Channel Bars ----
setup.initRcBars = function () {
    const barContainer = $(".rc-bars");
    barContainer.empty();

    const barNames = ["Roll", "Pitch", "Yaw", "Throttle"];
    const numChannels = FC.RC.active_channels > 0 ? FC.RC.active_channels : 8;

    for (let i = 0; i < numChannels; i++) {
        let name;
        if (i < barNames.length) {
            name = barNames[i];
        } else {
            name = `AUX ${i - 3}`;
        }

        barContainer.append(`\
            <ul>\
                <li class="name">${name}</li>\
                <li class="meter">\
                    <div class="meter-bar">\
                        <div class="label"></div>\
                        <div class="fill">\
                            <div class="label"></div>\
                        </div>\
                    </div>\
                </li>\
            </ul>\
        `);
    }

    this._rcMeterFills = barContainer.find(".fill");
    this._rcMeterLabels = barContainer.find(".meter-bar > .label");
};

setup.updateRcBars = function () {
    if (!this._rcMeterFills) return;

    const min = 800;
    const max = 2200;

    for (let i = 0; i < FC.RC.active_channels; i++) {
        const value = FC.RC.channels[i];
        const percent = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));

        $(this._rcMeterFills[i]).css("width", `${percent}%`);
        // Show value in both labels (outer and inner)
        $(this._rcMeterLabels[i]).text(value);
        $(this._rcMeterFills[i]).find(".label").text(value);
    }
};

// ---- Blackbox Device ----
setup.initBlackboxDevice = function () {
    const deviceSelect = $("select[name='blackbox_device']");
    deviceSelect.empty();

    deviceSelect.append(`<option value="0">${i18n.getMessage("blackboxLoggingNone")}</option>`);
    if (FC.DATAFLASH.supported) {
        deviceSelect.append(`<option value="1">${i18n.getMessage("blackboxLoggingFlash")}</option>`);
    }
    if (FC.SDCARD.supported) {
        deviceSelect.append(`<option value="2">${i18n.getMessage("blackboxLoggingSdCard")}</option>`);
    }
    deviceSelect.append(`<option value="3">${i18n.getMessage("blackboxLoggingSerial")}</option>`);

    deviceSelect.val(FC.BLACKBOX.blackboxDevice);

    deviceSelect.change(function () {
        FC.BLACKBOX.blackboxDevice = parseInt($(this).val(), 10);
        MSP.send_message(
            MSPCodes.MSP_SET_BLACKBOX_CONFIG,
            mspHelper.crunch(MSPCodes.MSP_SET_BLACKBOX_CONFIG),
            false,
            function () {
                gui_log(i18n.getMessage("blackboxConfigurationSaved"));
            },
        );
    });
};

// ---- Pilot / Craft Name + Font Upload ----
setup.initNamesAndFont = function () {
    // Populate current values
    if (semver.gte(FC.CONFIG.apiVersion, API_VERSION_1_45)) {
        $("#setup-pilot-name").val(FC.CONFIG.pilotName || "");
        $("#setup-craft-name").val(FC.CONFIG.craftName || "");
    } else {
        $("#setup-pilot-name").val(FC.CONFIG.name || "");
        $("#setup-craft-name").val(FC.CONFIG.name || "");
    }

    // Save buttons
    $(".setup-name-save").click(function (e) {
        e.preventDefault();
        const target = $(this).data("target");

        if (target === "pilot") {
            const val = $("#setup-pilot-name").val().trim();
            if (semver.gte(FC.CONFIG.apiVersion, API_VERSION_1_45)) {
                FC.CONFIG.pilotName = val;
                MSP.send_message(
                    MSPCodes.MSP2_SET_TEXT,
                    mspHelper.crunch(MSPCodes.MSP2_SET_TEXT, MSPCodes.PILOT_NAME),
                    false,
                    function () {
                        MSP.send_message(MSPCodes.MSP_EEPROM_WRITE, false, false, function () {
                            gui_log(`Pilot name saved: ${  val}`);
                        });
                    },
                );
            }
        } else if (target === "craft") {
            const val = $("#setup-craft-name").val().trim();
            if (semver.gte(FC.CONFIG.apiVersion, API_VERSION_1_45)) {
                FC.CONFIG.craftName = val;
                MSP.send_message(
                    MSPCodes.MSP2_SET_TEXT,
                    mspHelper.crunch(MSPCodes.MSP2_SET_TEXT, MSPCodes.CRAFT_NAME),
                    false,
                    function () {
                        MSP.send_message(MSPCodes.MSP_EEPROM_WRITE, false, false, function () {
                            gui_log(`Craft name saved: ${  val}`);
                        });
                    },
                );
            } else {
                FC.CONFIG.name = val;
                MSP.send_message(MSPCodes.MSP_SET_NAME, mspHelper.crunch(MSPCodes.MSP_SET_NAME), false, function () {
                    MSP.send_message(MSPCodes.MSP_EEPROM_WRITE, false, false, function () {
                        gui_log(`Craft name saved: ${  val}`);
                    });
                });
            }
        }
    });

    // Font upload dialog
    const fontUploadDialog = initializeModalDialog(null, ".dialogFontUpload", "osdSetupFontManagerTitle");

    // Font parsing + upload helper
    function parseMcmAndUpload(contents) {
        if (GUI.connect_lock) return;

        const data = contents.trim().split("\n");
        if (data.shift().trim() !== "MAX7456") {
            gui_log("Invalid font file (no MAX7456 header)");
            return;
        }

        const characters = [];
        const charBytes = [];
        for (let i = 0; i < data.length; i++) {
            const line = data[i].trim();
            if (!line) continue;
            charBytes.push(parseInt(line, 2));
            if (charBytes.length === 64) {
                characters.push(charBytes.slice(0, 54));
                charBytes.length = 0;
            }
        }
        if (charBytes.length === 64) {
            characters.push(charBytes.slice(0, 54));
        }

        if (characters.length === 0) {
            gui_log("Font file contains no characters");
            return;
        }

        GUI.connect_lock = true;
        const $progress = $(".dialogFontUpload progress.setup-font-progress");
        const $percent = $(".font-upload-percent");
        const $status = $(".font-upload-status");

        $progress.val(0);
        $percent.text("0%");
        $status.text(`Uploading ${  characters.length  } characters...`);
        fontUploadDialog.showModal();
        gui_log(`Uploading ${  characters.length  } font characters...`);

        let idx = 0;
        function uploadNext() {
            if (idx >= characters.length) {
                $progress.val(100);
                $percent.text("100%");
                $status.text("Upload complete! Rebooting...");
                gui_log("Font upload complete, rebooting...");
                GUI.connect_lock = false;
                fontUploadDialog.close();
                reinitializeConnection();
                return;
            }
            const pct = Math.round((idx / characters.length) * 100);
            $progress.val(pct);
            $percent.text(`${pct  }%`);
            const payload = [idx].concat(characters[idx]);
            MSP.send_message(MSPCodes.MSP_OSD_CHAR_WRITE, payload, false, function () {
                idx++;
                uploadNext();
            });
        }
        uploadNext();
    }

    // Upload official font from preset
    $(".setup-font-official-btn").click(function (e) {
        e.preventDefault();
        if (GUI.connect_lock) return;
        const fontFile = $("#setup-font-preset").val();
        const url = `./resources/osd/2/${fontFile}.mcm`;
        $.get(url, function (data) {
            parseMcmAndUpload(data);
        }).fail(function () {
            gui_log(`Failed to load font: ${  fontFile}`);
        });
    });

    // Upload custom .mcm font
    $(".setup-font-upload-btn").click(function (e) {
        e.preventDefault();
        if (GUI.connect_lock) return;
        FileSystem.pickOpenFile(i18n.getMessage("fileSystemPickerFiles", { typeof: "MCM" }), ".mcm")
            .then(function (file) {
                return FileSystem.readFile(file);
            })
            .then(function (contents) {
                parseMcmAndUpload(contents);
            })
            .catch(function (err) {
                console.error("Font upload error:", err);
            });
    });
};

// ---- VTX Status + Frequency Table ----
setup.initVtxStatus = function () {
    this.updateVtxConfigDisplay();
    this.buildVtxFreqTable();
};

setup.buildVtxFreqTable = function () {
    const wrapper = $(".vtx-freq-table-wrapper");
    wrapper.empty();

    const bands = this._vtxBandList;
    if (!bands || bands.length === 0) return;

    const numChannels = FC.VTX_CONFIG.vtx_table_channels || 0;
    if (numChannels === 0) return;

    // Build compact frequency grid: rows=bands, cols=channels
    let html = '<table class="vtx-freq-table"><thead><tr><th></th>';
    for (let ch = 1; ch <= numChannels; ch++) {
        html += `<th>C${ch}</th>`;
    }
    html += "</tr></thead><tbody>";

    for (let b = 0; b < bands.length; b++) {
        const band = bands[b];
        html += `<tr><td class="vtx-band-letter">${band.vtxtable_band_letter}</td>`;
        for (let ch = 0; ch < numChannels; ch++) {
            const freq = band.vtxtable_band_frequencies[ch] || 0;
            const bandNum = band.vtxtable_band_number;
            const chNum = ch + 1;
            html += `<td class="vtx-freq-cell" data-band="${bandNum}" data-ch="${chNum}">${freq || "-"}</td>`;
        }
        html += "</tr>";
    }
    html += "</tbody></table>";

    wrapper.html(html);
    this.highlightActiveVtxCell();
};

setup.highlightActiveVtxCell = function () {
    $(".vtx-freq-cell").removeClass("vtx-active");

    // Use real-time device status if available, fallback to config
    const ds = FC.VTX_DEVICE_STATUS;
    const activeBand = ds && ds._band !== undefined ? ds._band : FC.VTX_CONFIG.vtx_band;
    const activeCh = ds && ds._channel !== undefined ? ds._channel : FC.VTX_CONFIG.vtx_channel;

    if (activeBand > 0 && activeCh > 0) {
        $(`.vtx-freq-cell[data-band="${activeBand}"][data-ch="${activeCh}"]`).addClass("vtx-active");
    }

    // Show active frequency below table
    const activeCell = $(".vtx-freq-cell.vtx-active");
    const freqText = activeCell.length ? `${activeCell.text()} MHz` : "-";
    $(".vtx-active-freq-value").text(freqText);
};

setup.updateVtxConfigDisplay = function () {
    const vtxType = FC.VTX_CONFIG.vtx_type;
    let typeStr = "Unknown";

    switch (vtxType) {
        case VtxDeviceTypes.VTXDEV_UNSUPPORTED:
            typeStr = "Unsupported";
            break;
        case VtxDeviceTypes.VTXDEV_RTC6705:
            typeStr = "RTC6705";
            break;
        case VtxDeviceTypes.VTXDEV_SMARTAUDIO:
            typeStr = "SmartAudio";
            break;
        case VtxDeviceTypes.VTXDEV_TRAMP:
            typeStr = "Tramp";
            break;
        case VtxDeviceTypes.VTXDEV_MSP:
            typeStr = "MSP";
            break;
    }

    $("#setup_vtx_type_description").text(typeStr);
    $("#setup_vtx_power_description").text(FC.VTX_CONFIG.vtx_power);
    $("#setup_vtx_pit_mode_description").text(
        FC.VTX_CONFIG.vtx_pit_mode ? i18n.getMessage("yes") : i18n.getMessage("no"),
    );
};

setup.updateVtxStatus = function () {
    const ds = FC.VTX_DEVICE_STATUS;
    const hasStatus = ds !== null && ds !== undefined;

    // Ready state
    const ready = hasStatus ? ds.deviceIsReady : FC.VTX_CONFIG.vtx_device_ready;
    $(".vtx_ready").text(ready ? i18n.getMessage("vtxReadyTrue") : i18n.getMessage("vtxReadyFalse"));
    $(".vtx_ready").toggleClass("ready", !!ready);

    // Real-time power from device status
    if (hasStatus && ds._powerIndex !== undefined && ds._levels && ds._levels.length > 0) {
        const idx = ds._powerIndex > 0 ? ds._powerIndex - 1 : 0;
        const mw = ds._levels[idx] !== undefined ? ds._levels[idx] : ds._powerIndex;
        $("#setup_vtx_power_description").text(`${mw} mW`);
    }

    // Real-time frequency display
    if (hasStatus && ds._frequency !== undefined) {
        $(".vtx-live-freq-value").text(`${ds._frequency} MHz`);
    }

    // Pit mode from vtxStatus bitfield (bit 0 = pit mode)
    if (hasStatus && ds._vtxStatus !== undefined) {
        const pitMode = !!(ds._vtxStatus & 0x01);
        $("#setup_vtx_pit_mode_description").text(pitMode ? i18n.getMessage("yes") : i18n.getMessage("no"));
    }

    // Update active cell highlight (band/channel from live device status)
    this.highlightActiveVtxCell();
};

setup.initModel = function () {
    this.model = new Model($(".model-and-info #canvas_wrapper"), $(".model-and-info #canvas"));

    $(window).on("resize", $.proxy(this.model.resize, this.model));
};

setup.renderModel = function () {
    const x = FC.SENSOR_DATA.kinematics[1] * -1.0 * 0.017453292519943295,
        y = (FC.SENSOR_DATA.kinematics[2] * -1.0 - this.yaw_fix) * 0.017453292519943295,
        z = FC.SENSOR_DATA.kinematics[0] * -1.0 * 0.017453292519943295;

    this.model.rotateTo(x, y, z);
};

setup.cleanup = function (callback) {
    $(document).off("mouseup.motortest touchend.motortest");

    // Disable motor test mode if it was active
    if (this._motorTestEnabled) {
        this._motorTestEnabled = false;
        const motorCount = FC.MOTOR_CONFIG.motor_count;
        const mspBuffer = [];
        for (let m = 0; m < motorCount; m++) {
            const val = FC.MOTOR_CONFIG.mincommand;
            mspBuffer.push(val & 0xff);
            mspBuffer.push((val >> 8) & 0xff);
        }
        MSP.send_message(MSPCodes.MSP_SET_MOTOR, mspBuffer, false);
        mspHelper.setArmingEnabled(false, false);
    }

    if (this.model) {
        $(window).off("resize", $.proxy(this.model.resize, this.model));
        this.model.dispose();
    }

    if (callback) callback();
};

setup.expertModeChanged = function () {
    this.refresh();
};

setup.refresh = function () {
    const self = this;

    GUI.tab_switch_cleanup(function () {
        self.initialize();
    });
};

TABS.setup = setup;

export { setup };
