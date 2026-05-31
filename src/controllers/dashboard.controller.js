import mongoose from "mongoose";
import { Video } from "../models/video.model.js";
import { Subscription } from "../models/subscription.model.js";
import { Like } from "../models/like.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const getChannelStats = asyncHandler(async (req, res) => {
  const userId = req.user?._id;

  const totalVideos = await Video.countDocuments({ owner: userId });

  const stats = await Video.aggregate([
    { $match: { owner: new mongoose.Types.ObjectId(userId) } },
    {
      $group: {
        _id: null,
        totalViews: { $sum: "$views" },
      },
    },
  ]);

  const totalSubscribers = await Subscription.countDocuments({
    channel: userId,
  });

  const totalLikes = await Like.aggregate([
    {
      $lookup: {
        from: "videos",
        localField: "video",
        foreignField: "_id",
        as: "video",
      },
    },
    { $unwind: "$video" },
    { $match: { "video.owner": new mongoose.Types.ObjectId(userId) } },
    { $count: "totalLikes" },
  ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        totalVideos,
        totalViews: stats[0]?.totalViews || 0,
        totalSubscribers,
        totalLikes: totalLikes[0]?.totalLikes || 0,
      },
      "Channel stats fetched successfully"
    )
  );
});

const getChannelVideos = asyncHandler(async (req, res) => {
  const userId = req.user?._id;

  const videos = await Video.find({ owner: userId });

  return res
    .status(200)
    .json(new ApiResponse(200, videos, "Channel videos fetched successfully"));
});

export { getChannelStats, getChannelVideos };
