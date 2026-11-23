
import { ObjectId } from "mongodb";

const verifyActiveUser = async (req, res, next) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User information not found.",
      });
    }

    const db = req.app.locals.db;

    const userFilter = ObjectId.isValid(userId)
      ? {
          $or: [
            { _id: userId },
            { _id: new ObjectId(userId) },
          ],
        }
      : { _id: userId };

    const user = await db.collection("user").findOne(userFilter);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User not found.",
      });
    }

    if (user.isBlocked === true) {
      return res.status(403).json({
        success: false,
        message: "Your account has been blocked.",
      });
    }

    next();
  } catch (error) {
    console.error("Active User Verification Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to verify user status.",
    });
  }
};

export default verifyActiveUser;