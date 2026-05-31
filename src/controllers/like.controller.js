import mongoose, { isValidObjectId } from "mongoose";
import { Like } from "../models/like.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const toggleVideoLike = asyncHandler(async (req, res) => {
  const { videoId } = req.params;

  if (!isValidObjectId(videoId)) {
    throw new ApiError(400, "Invalid video id");
  }

  const existedLike = await Like.findOne({
    video: videoId,
    likedBy: req.user?._id,
  });

  if (existedLike) {
    await Like.findByIdAndDelete(existedLike._id);
    return res
      .status(200)
      .json(
        new ApiResponse(200, { isLiked: false }, "Like removed successfully")
      );
  }

  await Like.create({
    video: videoId,
    likedBy: req.user?._id,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, { isLiked: true }, "Like added successfully"));
});

const toggleCommentLike = asyncHandler(async (req, res) => {
  const { commentId } = req.params;

  if (!isValidObjectId(commentId)) {
    throw new ApiError(400, "Invalid comment id");
  }

  const existedLike = await Like.findOne({
    comment: commentId,
    likedBy: req.user?._id,
  });

  if (existedLike) {
    await Like.findByIdAndDelete(existedLike._id);
    return res
      .status(200)
      .json(
        new ApiResponse(200, { isLiked: false }, "Like removed successfully")
      );
  }

  await Like.create({
    comment: commentId,
    likedBy: req.user?._id,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, { isLiked: true }, "Like added successfully"));
});

const toggleTweetLike = asyncHandler(async (req, res) => {
  const { tweetId } = req.params;

  if (!isValidObjectId(tweetId)) {
    throw new ApiError(400, "Invalid tweet id");
  }

  const existedLike = await Like.findOne({
    tweet: tweetId,
    likedBy: req.user?._id,
  });

  if (existedLike) {
    await Like.findByIdAndDelete(existedLike._id);
    return res
      .status(200)
      .json(
        new ApiResponse(200, { isLiked: false }, "Like removed successfully")
      );
  }

  await Like.create({
    tweet: tweetId,
    likedBy: req.user?._id,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, { isLiked: true }, "Like added successfully"));
});

const getLikedVideos = asyncHandler(async (req, res) => {
  const likedVideos = await Like.find({
    likedBy: req.user?._id,
    video: { $exists: true },
  }).populate("video");

  return res
    .status(200)
    .json(
      new ApiResponse(200, likedVideos, "Liked videos fetched successfully")
    );
});

export { toggleCommentLike, toggleTweetLike, toggleVideoLike, getLikedVideos };
