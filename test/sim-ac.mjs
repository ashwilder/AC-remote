// Simulated Matter Room Air Conditioner, used only to test the app without real hardware.
// Usage: node test/sim-ac.mjs [storageDir]
import { Environment, ServerNode, VendorId } from "@matter/main";
import { RoomAirConditionerDevice } from "@matter/main/devices/room-air-conditioner";
import { ThermostatServer } from "@matter/main/behaviors/thermostat";
import { FanControlServer } from "@matter/main/behaviors/fan-control";
import { TemperatureMeasurementServer } from "@matter/main/behaviors/temperature-measurement";
import { Thermostat } from "@matter/main/clusters/thermostat";
import { FanControl } from "@matter/main/clusters/fan-control";

Environment.default.vars.set("storage.path", process.argv[2] ?? ".sim-ac-storage");

const node = await ServerNode.create({
    id: "sim-ac",
    network: { port: 5550 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    productDescription: { name: "Simulated Panasonic AC", deviceType: RoomAirConditionerDevice.deviceType },
    basicInformation: {
        vendorName: "Simulated Panasonic",
        vendorId: VendorId(0xfff1),
        productName: "Sim Room AC",
        productId: 0x8000,
        nodeLabel: "Bedroom AC",
        serialNumber: "SIM-0001",
    },
});

const endpoint = await node.add(
    RoomAirConditionerDevice.with(
        ThermostatServer.with("Cooling", "Heating"),
        FanControlServer.with("MultiSpeed", "Auto"),
        TemperatureMeasurementServer,
    ),
    {
        id: "ac",
        onOff: { onOff: false },
        thermostat: {
            localTemperature: 2950,
            controlSequenceOfOperation: Thermostat.ControlSequenceOfOperation.CoolingAndHeating,
            systemMode: Thermostat.SystemMode.Cool,
            occupiedCoolingSetpoint: 2400,
            occupiedHeatingSetpoint: 2000,
            minCoolSetpointLimit: 1600,
            maxCoolSetpointLimit: 3000,
            minHeatSetpointLimit: 1600,
            maxHeatSetpointLimit: 3000,
            absMinCoolSetpointLimit: 1600,
            absMaxCoolSetpointLimit: 3000,
            absMinHeatSetpointLimit: 1600,
            absMaxHeatSetpointLimit: 3000,
        },
        fanControl: {
            fanMode: FanControl.FanMode.Auto,
            fanModeSequence: FanControl.FanModeSequence.OffLowMedHighAuto,
            percentSetting: 0,
            percentCurrent: 0,
            speedMax: 3,
            speedSetting: 0,
            speedCurrent: 0,
        },
        temperatureMeasurement: { measuredValue: 2950, minMeasuredValue: 0, maxMeasuredValue: 5000 },
    },
);

endpoint.events.onOff.onOff$Changed.on(v => console.log(`[sim] power -> ${v ? "ON" : "OFF"}`));
endpoint.events.thermostat.systemMode$Changed.on(v => console.log(`[sim] mode -> ${v}`));
endpoint.events.thermostat.occupiedCoolingSetpoint$Changed.on(v => console.log(`[sim] cool setpoint -> ${v / 100}°C`));
endpoint.events.fanControl.fanMode$Changed.on(v => console.log(`[sim] fan mode -> ${v}`));

await node.start();
const { manualPairingCode, qrPairingCode } = node.state.commissioning.pairingCodes;
console.log(`[sim] ready. Manual pairing code: ${manualPairingCode}  QR: ${qrPairingCode}`);

// Drift the room temperature so live updates can be seen in the app.
setInterval(async () => {
    const cur = endpoint.state.thermostat.localTemperature ?? 2950;
    const on = endpoint.state.onOff.onOff;
    const next = Math.max(1800, Math.min(3400, cur + (on ? -10 : 10)));
    await endpoint.set({ thermostat: { localTemperature: next }, temperatureMeasurement: { measuredValue: next } });
}, 5000);
