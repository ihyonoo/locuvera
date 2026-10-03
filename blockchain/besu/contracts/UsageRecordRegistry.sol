pragma solidity ^0.8.20;

contract UsageRecordRegistry {
    address public owner;
    address public recorder;

    event RecorderChanged(address indexed previousRecorder, address indexed newRecorder);

    constructor(address initialRecorder) {
        require(initialRecorder != address(0), "recorder required");
        owner = msg.sender;
        recorder = initialRecorder;
    }

    function setRecorder(address newRecorder) external {
        require(msg.sender == owner, "owner only");
        require(newRecorder != address(0), "recorder required");
        emit RecorderChanged(recorder, newRecorder);
        recorder = newRecorder;
    }

    struct MovementPoint {
        string location;
        uint64 at;
    }

    struct UsageRecord {
        uint64 checkoutUserId;
        uint64 returnUserId;
        string tagId;
        string checkoutLocation;
        uint64 checkoutAt;
        string returnLocation;
        uint64 returnedAt;
        uint64 recordedAt;
        address recorder;
        bool exists;
        MovementPoint[] movementPath;
    }

    mapping(string => UsageRecord) private records;

    event UsageRecordStored(
        string usageId,
        uint64 checkoutUserId,
        uint64 returnUserId,
        string tagId,
        string checkoutLocation,
        uint64 checkoutAt,
        string returnLocation,
        uint64 returnedAt,
        address indexed recorder,
        uint64 recordedAt
    );

    function recordUsageRecord(
        string calldata usageId,
        uint64 checkoutUserId,
        uint64 returnUserId,
        string calldata tagId,
        string calldata checkoutLocation,
        uint64 checkoutAt,
        string calldata returnLocation,
        uint64 returnedAt,
        MovementPoint[] calldata movementPath
    ) external {
        require(msg.sender == recorder, "recorder only");
        require(bytes(usageId).length > 0, "usageId required");
        require(bytes(tagId).length > 0, "tagId required");
        require(checkoutUserId > 0, "checkoutUserId required");
        require(returnUserId > 0, "returnUserId required");
        require(checkoutAt > 0, "checkoutAt required");
        require(returnedAt > 0, "returnedAt required");
        require(returnedAt >= checkoutAt, "returnedAt before checkoutAt");
        require(!records[usageId].exists, "usageId already recorded");

        uint64 recordedAt = uint64(block.timestamp);

        UsageRecord storage record = records[usageId];
        record.checkoutUserId = checkoutUserId;
        record.returnUserId = returnUserId;
        record.tagId = tagId;
        record.checkoutLocation = checkoutLocation;
        record.checkoutAt = checkoutAt;
        record.returnLocation = returnLocation;
        record.returnedAt = returnedAt;
        record.recordedAt = recordedAt;
        record.recorder = msg.sender;
        record.exists = true;
        for (uint256 i = 0; i < movementPath.length; i++) {
            record.movementPath.push(movementPath[i]);
        }

        emit UsageRecordStored(
            usageId,
            checkoutUserId,
            returnUserId,
            tagId,
            checkoutLocation,
            checkoutAt,
            returnLocation,
            returnedAt,
            msg.sender,
            recordedAt
        );
    }

    function getUsageRecord(string calldata usageId)
        external
        view
        returns (
            uint64 checkoutUserId,
            uint64 returnUserId,
            string memory tagId,
            string memory checkoutLocation,
            uint64 checkoutAt,
            string memory returnLocation,
            uint64 returnedAt,
            uint64 recordedAt,
            address recorder,
            bool exists,
            MovementPoint[] memory movementPath
        )
    {
        UsageRecord storage record = records[usageId];
        return (
            record.checkoutUserId,
            record.returnUserId,
            record.tagId,
            record.checkoutLocation,
            record.checkoutAt,
            record.returnLocation,
            record.returnedAt,
            record.recordedAt,
            record.recorder,
            record.exists,
            record.movementPath
        );
    }
}
